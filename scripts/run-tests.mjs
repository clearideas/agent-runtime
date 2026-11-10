#!/usr/bin/env node
/**
 * Runs every workspace test suite quietly and prints one summary screen:
 * a per-package table, totals, the environment facts that decide which
 * execution suites run, and compact failure details.
 *
 *   node scripts/run-tests.mjs                 # everything
 *   node scripts/run-tests.mjs --only sandbox  # packages whose name or path contains "sandbox"
 *   node scripts/run-tests.mjs --verbose       # full failure messages and stacks
 *
 * Exit code is 1 when any test fails or a suite cannot be executed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = { only: [], verbose: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--verbose") options.verbose = true;
  else if (argument === "--only")
    options.only.push(process.argv[++index] ?? "");
  else if (argument.startsWith("--only=")) options.only.push(argument.slice(7));
  else {
    process.stderr.write(`Unknown option: ${argument}\n`);
    process.exit(2);
  }
}

const stripAnsi = (text) =>
  text.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "").replace(/\r\n/gu, "\n");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Workspace packages with a test script, in the order npm would run them. */
const discoverSuites = () => {
  const root = readJson(path.join(repository, "package.json"));
  const directories = root.workspaces.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [path.join(repository, pattern)];
    const parent = path.join(repository, pattern.slice(0, -2));
    return spawnSync(process.execPath, [
      "-e",
      "process.stdout.write(require('fs').readdirSync(process.argv[1]).join('\\n'))",
      parent,
    ])
      .stdout.toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((name) => path.join(parent, name));
  });
  const suites = [];
  for (const directory of directories.sort()) {
    const manifestFile = path.join(directory, "package.json");
    if (!existsSync(manifestFile)) continue;
    const manifest = readJson(manifestFile);
    const script = manifest.scripts?.test;
    if (!script) continue;
    suites.push({
      name: manifest.name,
      directory,
      label: path.relative(repository, directory),
      script,
    });
  }
  const examples = root.scripts?.["test:examples"];
  if (examples) {
    suites.push({
      name: "examples",
      directory: repository,
      label: "examples",
      script: examples,
    });
  }
  return suites;
};

const resolveVitest = (directory) => {
  const require = createRequire(path.join(directory, "package.json"));
  return path.join(
    path.dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  );
};

const runVitest = (suite, scratch) => {
  const outputFile = path.join(
    scratch,
    `${suite.label.replace(/[^A-Za-z0-9]+/gu, "-")}.json`,
  );
  const extra = suite.script
    .replace(/^vitest\s+run\s*/u, "")
    .split(/\s+/u)
    .filter(Boolean);
  const started = Date.now();
  const child = spawnSync(
    process.execPath,
    [
      resolveVitest(suite.directory),
      "run",
      ...extra,
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ],
    {
      cwd: suite.directory,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    },
  );
  const durationMs = Date.now() - started;
  if (!existsSync(outputFile)) {
    return {
      suite,
      durationMs,
      error: stripAnsi(`${child.stdout}\n${child.stderr}`).trim(),
      files: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
    };
  }
  const report = readJson(outputFile);
  const failures = [];
  for (const file of report.testResults ?? []) {
    const fileLabel = path.relative(suite.directory, file.name);
    for (const test of file.assertionResults ?? []) {
      if (test.status !== "failed") continue;
      failures.push({
        title: [fileLabel, ...(test.ancestorTitles ?? []), test.title].join(
          " › ",
        ),
        message: stripAnsi((test.failureMessages ?? []).join("\n"))
          .split("\n")
          // Keep the message and frames in the repository; drop runner internals.
          .filter(
            (line) =>
              !/^\s+at .*(node_modules|node:internal|<anonymous>)/u.test(line),
          )
          .join("\n"),
      });
    }
    if (
      file.status === "failed" &&
      (file.assertionResults ?? []).length === 0
    ) {
      failures.push({
        title: fileLabel,
        message: stripAnsi(file.message ?? "Suite failed to run."),
      });
    }
  }
  return {
    suite,
    durationMs,
    files: (report.testResults ?? []).length,
    passed: report.numPassedTests ?? 0,
    failed: Math.max(report.numFailedTests ?? 0, failures.length),
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    failures,
    ...(child.status !== 0 && failures.length === 0
      ? { error: stripAnsi(child.stderr).trim() }
      : {}),
  };
};

const runNodeTest = (suite) => {
  const files = suite.script
    .replace(/^node\s+--test\s*/u, "")
    .split(/\s+/u)
    .filter(Boolean);
  const started = Date.now();
  const child = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...files],
    { cwd: suite.directory, encoding: "utf8" },
  );
  const durationMs = Date.now() - started;
  const output = stripAnsi(`${child.stdout}\n${child.stderr}`);
  const count = (label) =>
    Number(output.match(new RegExp(`^# ${label} (\\d+)$`, "mu"))?.[1] ?? 0);
  const failures = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^not ok \d+ - (.+)$/u.exec(lines[index]);
    if (!match) continue;
    const detail = [];
    let inError = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^(not )?ok \d+/u.test(line) || line.startsWith("# ")) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed === "---" || trimmed === "...") continue;
      if (/^(code|stack|duration_ms|type|failureType):/u.test(trimmed)) {
        inError = false;
        continue;
      }
      if (trimmed.startsWith("location:")) {
        detail.push(trimmed);
        continue;
      }
      if (trimmed.startsWith("error:")) {
        inError = true;
        const inline = trimmed.replace(/^error:\s*\|-?\s*/u, "").trim();
        if (inline) detail.push(inline);
        continue;
      }
      if (inError) detail.push(trimmed);
    }
    failures.push({ title: match[1], message: detail.join("\n") });
  }
  return {
    suite,
    durationMs,
    files: files.length,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skipped") + count("todo"),
    failures,
    ...(child.status !== 0 && failures.length === 0
      ? { error: output.trim() }
      : {}),
  };
};

const probe = (command, args) =>
  spawnSync(command, args, { encoding: "utf8" }).status === 0;

const environment = () => {
  const python =
    process.platform !== "win32" && probe("python3", ["--version"]);
  const bubblewrap =
    process.platform === "linux" &&
    probe("bwrap", [
      "--unshare-all",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
      ...(existsSync("/bin") ? ["--ro-bind", "/bin", "/bin"] : []),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      "/bin/true",
    ]);
  return { python, bubblewrap };
};

const formatDuration = (ms) =>
  ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;

const main = () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "agent-runtime-tests-"));
  const suites = discoverSuites().filter(
    (suite) =>
      options.only.length === 0 ||
      options.only.some(
        (needle) => suite.name.includes(needle) || suite.label.includes(needle),
      ),
  );
  if (suites.length === 0) {
    process.stderr.write("No test suites matched.\n");
    process.exit(2);
  }
  const facts = environment();
  const width = Math.max(...suites.map((suite) => suite.name.length), 7) + 2;
  const header = `${"Package".padEnd(width)}  Files   Pass   Fail   Skip    Time`;
  process.stdout.write(
    `Agent Runtime tests\n\n${header}\n${"-".repeat(header.length)}\n`,
  );

  const results = [];
  try {
    for (const suite of suites) {
      const result = suite.script.startsWith("vitest")
        ? runVitest(suite, scratch)
        : runNodeTest(suite);
      results.push(result);
      const mark = result.error || result.failed > 0 ? "✖" : "✓";
      process.stdout.write(
        `${`${mark} ${suite.name}`.padEnd(width)}${String(result.files).padStart(7)}${String(result.passed).padStart(7)}${String(result.failed).padStart(7)}${String(result.skipped).padStart(7)}${formatDuration(result.durationMs).padStart(8)}\n`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const total = (key) => results.reduce((sum, result) => sum + result[key], 0);
  const errors = results.filter((result) => result.error);
  const failed = total("failed") + errors.length;
  process.stdout.write(
    `${"-".repeat(header.length)}\n${"Total".padEnd(width)}${String(total("files")).padStart(7)}${String(total("passed")).padStart(7)}${String(total("failed")).padStart(7)}${String(total("skipped")).padStart(7)}${formatDuration(total("durationMs")).padStart(8)}\n\n`,
  );
  process.stdout.write(
    `Environment: node ${process.version} on ${process.platform}/${process.arch}; python3 ${facts.python ? "available" : "unavailable"}; bubblewrap ${facts.bubblewrap ? "available" : "unavailable"}.\n`,
  );
  if (!facts.python || !facts.bubblewrap) {
    process.stdout.write(
      `Skipped execution suites: ${[
        !facts.python
          ? "helper and run-sandbox tests need Linux/macOS with python3"
          : "",
        !facts.bubblewrap
          ? "bubblewrap isolation and use-case scenarios need Linux with bubblewrap and unprivileged user namespaces"
          : "",
      ]
        .filter(Boolean)
        .join("; ")}.\n`,
    );
  }

  const failures = results.flatMap((result) =>
    result.failures.map((failure) => ({
      ...failure,
      suite: result.suite.name,
    })),
  );
  if (failures.length > 0 || errors.length > 0) {
    process.stdout.write(`\nFAILURES (${failures.length + errors.length})\n`);
    let number = 0;
    for (const failure of failures) {
      number += 1;
      const lines = failure.message.split("\n").filter((line) => line.trim());
      const shown = options.verbose ? lines : lines.slice(0, 6);
      process.stdout.write(
        `\n${number}. ${failure.suite} › ${failure.title}\n${shown.map((line) => `     ${line}`).join("\n")}${
          !options.verbose && lines.length > shown.length
            ? `\n     … ${lines.length - shown.length} more lines (use --verbose)`
            : ""
        }\n`,
      );
    }
    for (const result of errors) {
      number += 1;
      const lines = result.error.split("\n").filter((line) => line.trim());
      const shown = options.verbose ? lines : lines.slice(-8);
      process.stdout.write(
        `\n${number}. ${result.suite.name} › suite did not run\n${shown.map((line) => `     ${line}`).join("\n")}\n`,
      );
    }
  }
  if (
    failures.some((failure) =>
      /Failed to resolve entry for package "@clearideas|Cannot find package '@clearideas/u.test(
        failure.message,
      ),
    )
  ) {
    process.stdout.write(
      "\nHint: tests resolve sibling packages through their dist output; run `npm run build` first (or `npm run validate`).\n",
    );
  }
  process.stdout.write(
    `\n${failed === 0 ? "All tests passed." : `${failed} failing.`}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
};

main();
