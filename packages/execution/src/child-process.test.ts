import { describe, expect, it } from "vitest";

import { ChildProcessExecutionEngine } from "./child-process.js";

const workerSource = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const invocation = JSON.parse(input)
  const runId = invocation.request.runId
  const base = { protocolVersion: '1.0' }
  const event = (sequence, type) => ({
    ...base,
    type: 'event',
    event: { id: 'e' + sequence, runId, sequence, attempt: 1, timestamp: new Date().toISOString(), type }
  })
  process.stdout.write(JSON.stringify(event(1, 'run.started')) + '\\n')
  process.stdout.write(JSON.stringify(event(2, 'run.completed')) + '\\n')
  process.stdout.write(JSON.stringify({
    ...base,
    type: 'result',
    result: {
      runId,
      output: 'child-ok',
      state: {},
      stepResults: [],
      transcript: [],
      artifacts: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }
  }) + '\\n')
})
`;

describe("ChildProcessExecutionEngine", () => {
  it("runs the neutral worker protocol over stdio", async () => {
    const engine = new ChildProcessExecutionEngine({
      command: process.execPath,
      args: ["--input-type=module", "--eval", workerSource],
      inheritEnvironment: false,
    });
    const handle = await engine.submit({
      runId: "child-run",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    const events: string[] = [];
    for await (const event of engine.events(handle)) events.push(event.type);
    expect(events).toEqual(["run.started", "run.completed"]);
    await expect(engine.result(handle)).resolves.toMatchObject({
      runId: "child-run",
      output: "child-ok",
    });
  });

  it("normalizes worker process failures", async () => {
    const engine = new ChildProcessExecutionEngine({
      command: process.execPath,
      args: ["--eval", 'process.stderr.write("bad worker"); process.exit(4)'],
      inheritEnvironment: false,
    });
    const handle = await engine.submit({
      runId: "failed-child",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    for await (const _event of engine.events(handle)) {
      // Wait for the terminal state.
    }
    await expect(engine.result(handle)).rejects.toMatchObject({
      code: "WORKER_PROCESS_FAILED",
    });
  });
});
