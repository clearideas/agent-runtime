import {
  createAgentRuntime,
  defineAgent,
  FileRunStore,
  RunSuspendedError,
} from "@clearideas/agent-runtime";

const manifest = defineAgent({
  schemaVersion: "1.0",
  steps: [
    {
      id: "approve",
      type: "approval",
      prompt: "Approve the prepared release announcement?",
      action: "pause",
      includeInFinalOutput: true,
    },
  ],
});
const approved = process.argv.includes("--approve");
const runtime = createAgentRuntime({
  manifest,
  runStore: new FileRunStore(
    process.env.DEMO_STORE ?? ".agent-runtime/approval-example",
  ),
  approvals: {
    requestApproval: async () => {
      if (!approved) throw new RunSuspendedError("Approval required");
      return { approved: true, respondedAt: new Date().toISOString() };
    },
  },
});
try {
  const result = await runtime.run({
    runId: "release-approval",
    ...(approved ? { resume: true } : {}),
  });
  console.log(JSON.stringify(result.output));
} catch (error) {
  if (!(error instanceof RunSuspendedError)) throw error;
  console.log(
    "Suspended. In a new process, run: node examples/patterns/approval.mjs --approve",
  );
}
