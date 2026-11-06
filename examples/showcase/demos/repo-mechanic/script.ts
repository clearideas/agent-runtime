/**
 * Scripted model decisions for Repo Mechanic.
 *
 * Nothing here touches files or runs tests: the script only *asks* for tool
 * calls. Agent Runtime executes them in the run sandbox, and every branch
 * below is chosen from the real results it returns — failing test names,
 * search matches, file contents, and host-policy denials.
 */
import {
  lastResult,
  outputOf,
  type Script,
  type ScriptRequest,
  type ScriptTurn,
} from "../../lib/scripted-model.ts";

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface SearchOutput {
  matches: Array<{ path: string; line: number; text: string }>;
}
interface ReadOutput {
  path: string;
  content: string;
  totalLines: number;
}
interface ListOutput {
  files: Array<{ path: string }>;
}

const BUGGY = /^(\s*)discounted = subtotal - discount_rate\s*$/mu;
const FIXED_LINE = "discounted = subtotal * (1 - discount_rate)";

/** Summarize unittest output the way an engineer would read it. */
export const summarizeTests = (output: CommandOutput | undefined) => {
  const text = `${output?.stdout ?? ""}\n${output?.stderr ?? ""}`;
  const ran = Number(/Ran (\d+) tests?/u.exec(text)?.[1] ?? 0);
  const failing = [...text.matchAll(/^(?:FAIL|ERROR): (\w+)/gmu)].map(
    (match) => match[1]!,
  );
  return { ran, failing, passed: output?.exitCode === 0 };
};

const investigate = (request: ScriptRequest): ScriptTurn => {
  switch (request.turn) {
    case 0:
      return {
        say: "Let me get oriented in the repository first.",
        call: { name: "repo__list_files", input: {} },
      };
    case 1: {
      const files = outputOf<ListOutput>(lastResult(request))?.files ?? [];
      return {
        say: `The workspace exposes ${files.length} files. Reproducing the report with the test suite.`,
        call: { name: "repo__run_tests", input: {} },
      };
    }
    case 2: {
      const tests = summarizeTests(
        outputOf<CommandOutput>(lastResult(request)),
      );
      if (tests.passed) {
        return {
          output: {
            status: "healthy",
            summary: `All ${tests.ran} tests pass; the reported behaviour no longer reproduces.`,
            file: "",
            failingTests: [],
          },
        };
      }
      return {
        say: `${tests.failing.length} of ${tests.ran} tests fail: ${tests.failing.join(", ")}. Both involve discounts, so I'll search the source for discount_rate.`,
        call: {
          name: "repo__search_files",
          input: { query: "discount_rate", glob: "src/**" },
        },
      };
    }
    case 3: {
      const matches =
        outputOf<SearchOutput>(lastResult(request))?.matches ?? [];
      const suspect =
        matches.find((match) => match.text.includes("- discount_rate")) ??
        matches[0];
      if (!suspect) {
        return {
          output: {
            status: "bug",
            summary: "Tests fail, but no discount logic was found in src/.",
            file: "",
            failingTests: [],
          },
        };
      }
      return {
        say: `Line ${suspect.line} of ${suspect.path} looks wrong: \`${suspect.text.trim()}\`. Reading the function to confirm.`,
        call: { name: "repo__read_file", input: { path: suspect.path } },
      };
    }
    default: {
      const read = outputOf<ReadOutput>(lastResult(request));
      const tests = summarizeTests(outputOf<CommandOutput>(request.results[1]));
      return {
        output: {
          status: "bug",
          summary:
            "invoice_total subtracts discount_rate (a fraction such as 0.10) from the subtotal instead of reducing the subtotal by that percentage.",
          file: read?.path ?? "src/invoice.py",
          failingTests: tests.failing,
        },
      };
    }
  }
};

const fix = (request: ScriptRequest): ScriptTurn => {
  const file = /File: (\S+)/u.exec(request.prompt)?.[1] ?? "src/invoice.py";
  switch (request.turn) {
    case 0:
      return {
        say: `Opening ${file} to make the smallest correct change.`,
        call: { name: "repo__read_file", input: { path: file } },
      };
    case 1: {
      const read = outputOf<ReadOutput>(lastResult(request));
      if (!read || !BUGGY.test(read.content)) {
        return {
          output: `I could not find the faulty discount line in ${file}; no change was made.`,
        };
      }
      return {
        say: "Replacing the subtraction with a percentage reduction and writing the file.",
        call: {
          name: "repo__write_file",
          input: {
            path: file,
            // read_file returns lines without the final newline; keep it.
            content: read.content
              // Replace only the faulty expression; keep the file's line endings.
              .replace(
                "subtotal - discount_rate",
                "subtotal * (1 - discount_rate)",
              )
              .replace(/\n?$/u, "\n"),
          },
        },
      };
    }
    case 2: {
      const write = lastResult(request);
      if (write?.error) {
        return {
          output: [
            `**The host denied the write** (\`${write.error.code}\`): ${write.error.message}`,
            "",
            `Proposed change to \`${file}\`, not applied:`,
            "",
            "```diff",
            "-    discounted = subtotal - discount_rate",
            `+    ${FIXED_LINE}`,
            "```",
          ].join("\n"),
        };
      }
      return {
        say: "Written. Rerunning the test suite to confirm.",
        call: { name: "repo__run_tests", input: {} },
      };
    }
    default: {
      const tests = summarizeTests(
        outputOf<CommandOutput>(lastResult(request)),
      );
      return {
        output: tests.passed
          ? `Changed \`${file}\` to apply the discount as a percentage (\`${FIXED_LINE}\`). All ${tests.ran} tests now pass.`
          : `Changed \`${file}\`, but ${tests.failing.length} tests still fail: ${tests.failing.join(", ")}.`,
      };
    }
  }
};

const jsonAfter = (text: string, label: string): Record<string, unknown> => {
  const match = new RegExp(`${label}:\\s*(\\{[^\\n]*\\})`, "u").exec(text);
  try {
    return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const report = (request: ScriptRequest): ScriptTurn => {
  const diagnosis = jsonAfter(request.prompt, "Diagnosis");
  const verification = jsonAfter(request.prompt, "Independent verification");
  const notes = /Fix notes:\s*([\s\S]*?)\nIndependent verification:/u
    .exec(request.prompt)?.[1]
    ?.trim();
  const denied = notes?.includes("host denied the write") ?? false;
  const testsRun = Number(verification.testsRun ?? 0);
  const failed = Array.isArray(verification.failed) ? verification.failed : [];
  const evidence = verification.passed
    ? `Independent verification in the run sandbox: **${testsRun} tests run, 0 failed.**`
    : `Independent verification in the run sandbox: **${failed.length} of ${testsRun} tests still fail** (${failed.join(", ")}).`;

  if (diagnosis.status === "healthy") {
    return {
      output: [
        "## No change needed",
        "",
        String(diagnosis.summary ?? ""),
        "",
        evidence,
      ].join("\n"),
    };
  }
  return {
    output: [
      denied
        ? "## Proposed: apply invoice discounts as a percentage (not applied)"
        : "## Fix: apply invoice discounts as a percentage",
      "",
      `**Root cause.** ${String(diagnosis.summary ?? "")}`,
      "",
      `**Change.** ${denied ? "The host policy denied writes to the repository, so the patch below was proposed but not applied." : notes}`,
      ...(denied ? ["", notes ?? ""] : []),
      "",
      `**Evidence.** ${evidence}`,
    ].join("\n"),
  };
};

export const repoMechanicScript: Script = (request) => {
  if (request.prompt.includes("Reproduce the problem"))
    return investigate(request);
  if (request.prompt.includes("Fix the defect")) return fix(request);
  if (request.system.includes("pull-request descriptions"))
    return report(request);
  return { output: "This step is not part of the Repo Mechanic script." };
};
