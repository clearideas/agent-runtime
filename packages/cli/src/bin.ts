#!/usr/bin/env node
import { runCli } from "./index.js";

const controller = new AbortController();
const cancel = (signal: NodeJS.Signals): void => {
  if (!controller.signal.aborted) {
    controller.abort(new DOMException(`Received ${signal}.`, "AbortError"));
  }
};
const onSigint = (): void => cancel("SIGINT");
const onSigterm = (): void => cancel("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
try {
  process.exitCode = await runCli(process.argv.slice(2), undefined, {
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
