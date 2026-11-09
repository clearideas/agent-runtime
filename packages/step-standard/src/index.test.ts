import type {
  ApprovalStep,
  CodeStep,
  JsonObject,
  RunEvent,
  AgentManifest,
  SandboxCommandRecord,
  SubRunStep,
  WebhookStep,
} from "@clearideas/agent-runtime-contracts";
import type {
  ApprovalAdapter,
  ResolvedWorkspace,
  RunSandboxCommandRequest,
  RunSandboxSession,
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
      prompt: "Approve {{ Quarter }} secret acquisition for {{ deal.Name }}?",
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
      variables: { quarter: "Q4", Deal: { name: "private target" } },
      approvals,
      emit: collector.emit,
    });

    expect(requests).toEqual([
      {
        runId: "run-1",
        stepId: "approval-1",
        prompt: "Approve Q4 secret acquisition for private target?",
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
    expect(JSON.stringify(collector.events)).not.toContain("private target");
    expect(JSON.stringify(result.metadata)).not.toContain("private target");
    expect(JSON.stringify(collector.events)).not.toContain(
      "private approval response",
    );
    expect(JSON.stringify(result.metadata)).not.toContain(
      "private approval response",
    );
  });

  it.each([
    ["continue", { endRun: undefined }],
    ["complete", { endRun: true }],
  ] as const)(
    "records a rejection and keeps going with onReject: %s",
    async (onReject, expected) => {
      const step: ApprovalStep = {
        id: "approval-choice",
        type: "approval",
        prompt: "Publish?",
        outputVariable: "decision",
        onReject,
      };
      const result = await new ApprovalStepExecutor().execute({
        runId: "run-1",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: {},
        approvals: {
          requestApproval: async () => ({
            approved: false,
            response: { reviewer: "ana" },
            respondedAt: "2026-07-22T00:01:00.000Z",
          }),
        },
        emit: eventCollector().emit,
      });
      expect(result.output).toEqual({
        approved: false,
        respondedAt: "2026-07-22T00:01:00.000Z",
        response: { reviewer: "ana" },
      });
      expect(result.statePatch?.set?.decision).toMatchObject({
        approved: false,
      });
      expect(result.endRun).toBe(expected.endRun);
    },
  );

  it("cancels the run on a rejection with onReject: cancel", async () => {
    const step: ApprovalStep = {
      id: "approval-cancel",
      type: "approval",
      prompt: "Continue?",
      onReject: "cancel",
    };
    await expect(
      new ApprovalStepExecutor().execute({
        runId: "run-1",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: {},
        approvals: {
          requestApproval: async () => ({
            approved: false,
            respondedAt: "2026-07-22T00:01:00.000Z",
          }),
        },
        emit: eventCollector().emit,
      }),
    ).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  });

  it("reports missing adapters before a run starts", () => {
    const approval: ApprovalStep = {
      id: "approve",
      type: "approval",
      prompt: "?",
    };
    const code: CodeStep = {
      id: "code",
      type: "code",
      language: "python",
      code: "",
    };
    const runCode: CodeStep = { ...code, id: "run-code", sandbox: "run" };
    const subRun: SubRunStep = {
      id: "child",
      type: "sub-run",
      manifestRef: "x",
    };
    const host = { manifest: manifestFor(approval) };
    expect(new ApprovalStepExecutor().preflight(approval, host)).toEqual([
      "Approval step approve requires an ApprovalAdapter.",
    ]);
    expect(new CodeStepExecutor().preflight(code, host)).toEqual([
      "Code step code requires a SandboxAdapter.",
    ]);
    expect(new CodeStepExecutor().preflight(runCode, host)).toEqual([
      "Code step run-code requires a RunSandboxProvider.",
    ]);
    expect(new SubRunStepExecutor().preflight(subRun, host)).toEqual([
      "Sub-run step child requires a SubRunAdapter.",
    ]);
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

  it("settles cancellation raised synchronously by an approval adapter", async () => {
    const step: ApprovalStep = {
      id: "approval-startup",
      type: "approval",
      prompt: "Approve {{ quarter }}?",
    };
    const controller = new AbortController();
    await expect(
      new ApprovalStepExecutor().execute({
        runId: "r",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: { quarter: "Q4" },
        signal: controller.signal,
        approvals: {
          requestApproval: (request) => {
            expect(request.prompt).toBe("Approve Q4?");
            controller.abort(new Error("cancelled at startup"));
            return new Promise(() => undefined);
          },
        },
        emit: eventCollector().emit,
      }),
    ).rejects.toThrow("cancelled at startup");
  }, 1_000);

  it("does not start an approval request once the run is cancelled", async () => {
    const step: ApprovalStep = {
      id: "approval-cancelled",
      type: "approval",
      prompt: "Continue?",
    };
    const controller = new AbortController();
    const requested = vi.fn(async () => {
      // e.g. a durable host that suspends the run until a person decides.
      throw new Error("suspended");
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await expect(
        new ApprovalStepExecutor().execute({
          runId: "run-1",
          manifest: manifestFor(step),
          step,
          stepIndex: 0,
          variables: {},
          approvals: { requestApproval: requested },
          signal: controller.signal,
          emit: async (type, data) => {
            // The user cancels while the host handles the event.
            if (type === "approval.requested")
              controller.abort(new Error("cancelled"));
            return eventCollector().emit(type, data);
          },
        }),
      ).rejects.toThrow("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(requested).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
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

describe("code step cancellation admission", () => {
  it("does not start the sandbox after cancellation in code.execution.started", async () => {
    const step: CodeStep = {
      id: "cancel-code",
      type: "code",
      language: "python",
      code: "print('hello')",
    };
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      throw new Error("should not start");
    });
    await expect(
      new CodeStepExecutor().execute({
        runId: "r",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: {},
        signal: controller.signal,
        sandbox: { execute },
        emit: async (type, data) => {
          if (type === "code.execution.started")
            controller.abort(new Error("cancelled"));
          return eventCollector().emit(type, data);
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(execute).not.toHaveBeenCalled();
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

  it("executes in the run sandbox when workspaces are declared and records the command", async () => {
    const step: CodeStep = {
      id: "code-run",
      type: "code",
      language: "python",
      code: "print('ok')",
      workspaces: ["code"],
      outputVariable: "result",
    };
    const executed: RunSandboxCommandRequest[] = [];
    const record: SandboxCommandRecord = {
      id: "cmd-1-1",
      runId: "run-1",
      attempt: 1,
      stepId: "code-run",
      kind: "code",
      name: "code-run",
      argv: ["python3", "/workspace/steps/cmd-1-1/main.py"],
      cwd: "/workspace/steps/cmd-1-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      timedOut: false,
      stdoutBytes: 3,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      filesChanged: [],
      ignoredPaths: [],
      budget: {
        commandsUsed: 1,
        commandsLimit: 200,
        sandboxSecondsUsed: 1,
        sandboxSecondsLimit: 900,
      },
    };
    const session: RunSandboxSession = {
      id: "sb-1",
      execute: async (request) => {
        executed.push(request);
        return { record, output: "ok\n", stdout: "ok\n", stderr: "" };
      },
      budget: () => ({ commandsUsed: 1, sandboxSecondsUsed: 1 }),
      close: async () => undefined,
    };
    const workspace: ResolvedWorkspace = {
      binding: { ref: "repo", alias: "code" },
      alias: "code",
      mode: "read",
      store: {
        mode: "read",
        entries: async () => [],
        read: async () => new Uint8Array(),
      },
    };
    const collector = eventCollector();
    const result = await new CodeStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: { input: 21 },
      workspaces: [workspace],
      runSandbox: async () => session,
      emit: collector.emit,
    });
    expect(executed).toEqual([
      {
        stepId: "code-run",
        kind: "code",
        name: "code-run",
        arguments: {
          language: "python",
          code: "print('ok')",
          variables: { input: 21 },
          timeoutMs: 60_000,
          workspaces: ["code"],
        },
      },
    ]);
    expect(result.output).toBe("ok\n");
    expect(result.statePatch).toEqual({ set: { result: "ok\n" } });
    expect(result.metadata).toMatchObject({
      sandbox: "run",
      exitCode: 0,
      command: { id: "cmd-1-1" },
    });
    expect(
      collector.events.map((event) => [event.type, event.data?.sandbox]),
    ).toEqual([
      ["code.execution.started", "run"],
      ["code.execution.completed", "run"],
    ]);

    await expect(
      new CodeStepExecutor().execute({
        runId: "run-1",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: {},
        workspaces: [],
        runSandbox: async () => session,
        emit: collector.emit,
      }),
    ).rejects.toThrow(/requires workspace code, which is not available/u);
    await expect(
      new CodeStepExecutor().execute({
        runId: "run-1",
        manifest: manifestFor({
          ...step,
          workspaces: undefined,
          sandbox: "run",
        }),
        step: { ...step, workspaces: undefined, sandbox: "run" },
        stepIndex: 0,
        variables: {},
        emit: collector.emit,
      }),
    ).rejects.toThrow(/requires the run sandbox/u);
    const failing: RunSandboxSession = {
      ...session,
      execute: async () => ({
        record: { ...record, exitCode: 3 },
        stdout: "",
        stderr: "boom",
      }),
    };
    await expect(
      new CodeStepExecutor().execute({
        runId: "run-1",
        manifest: manifestFor(step),
        step,
        stepIndex: 0,
        variables: {},
        workspaces: [workspace],
        runSandbox: async () => failing,
        emit: collector.emit,
      }),
    ).rejects.toBeInstanceOf(SandboxExecutionError);
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
  it("forwards a signed history selection only when the step sets history", async () => {
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hi" }],
    };
    const requests: Parameters<SubRunAdapter["execute"]>[0][] = [];
    const subRuns: SubRunAdapter = {
      execute: async (request) => {
        requests.push(structuredClone(request));
        return { runId: "child-1", output: "ok" };
      },
    };
    const declaring = (step: SubRunStep): AgentManifest => ({
      schemaVersion: "1.0",
      messages: {},
      steps: [step],
    });
    const signature = {
      version: "1" as const,
      algorithm: "HMAC-SHA256" as const,
      keyId: "k1",
      count: 1,
      value: "mac",
    };
    const forwarding: SubRunStep = {
      id: "delegate",
      type: "sub-run",
      manifestRef: "agent://child",
      history: { last: 1 },
    };
    const collector = eventCollector();
    await new SubRunStepExecutor().execute({
      runId: "parent",
      manifest: declaring(forwarding),
      step: forwarding,
      stepIndex: 0,
      variables: { topic: "refunds", messages: { count: 1 } },
      history: {
        messages: [user],
        places: [{ turn: 1, position: 1 }],
        turn: 1,
        explicit: true,
        insert: true,
        media: "include",
        scope: "tenant:1",
        sign: async () => signature,
      },
      subRuns,
      emit: collector.emit,
    });
    expect(requests[0]).toMatchObject({
      variables: [{ key: "topic", value: "refunds" }],
      messages: [user],
      messagesSignature: signature,
      messagesScope: "tenant:1",
    });
    expect(collector.events[0]!.data).toMatchObject({ forwardedMessages: 1 });

    const silent: SubRunStep = {
      id: "silent",
      type: "sub-run",
      manifestRef: "agent://child",
    };
    await new SubRunStepExecutor().execute({
      runId: "parent",
      manifest: declaring(silent),
      step: silent,
      stepIndex: 0,
      variables: { topic: "refunds", messages: { count: 1 } },
      history: {
        messages: [user],
        places: [{ turn: 1, position: 1 }],
        turn: 1,
        explicit: false,
        insert: false,
        media: "include",
        sign: async () => signature,
      },
      subRuns,
      emit: eventCollector().emit,
    });
    expect(requests[1]!.messages).toBeUndefined();
    expect(requests[1]!.variables).toEqual([
      { key: "topic", value: "refunds" },
    ]);
  });
});
