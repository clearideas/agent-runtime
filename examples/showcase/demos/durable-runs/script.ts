/**
 * Scripted model decisions for Durable Runs. The script reads the real CSV
 * contents returned by the sandbox and computes the report from them. It is
 * stateless: after a pause it picks up from the conversation the runtime
 * restores, exactly as a real model would.
 */
import {
  lastResult,
  outputOf,
  type Script,
  type ScriptRequest,
  type ScriptTurn,
} from "../../lib/scripted-model.ts";

interface ReadOutput {
  path: string;
  content: string;
}
interface ListOutput {
  files: Array<{ path: string }>;
}

const money = (value: number) => `$${value.toLocaleString("en-US")}`;
const percent = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;

const parseCsv = (content = "") =>
  new Map(
    content
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(","))
      .filter((cells) => cells.length === 2)
      .map(([region, revenue]) => [region!.trim(), Number(revenue)]),
  );

/** Build the draft from the two quarters the sandbox returned. */
export const draftReport = (
  quarter: string,
  previous: string,
  current: Map<string, number>,
  prior: Map<string, number>,
) => {
  const change = (now: number, before: number) =>
    before ? ((now - before) / before) * 100 : 0;
  const rows = [...current].map(([region, revenue]) => {
    const before = prior.get(region) ?? 0;
    return { region, before, revenue, change: change(revenue, before) };
  });
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  const priorTotal = rows.reduce((sum, row) => sum + row.before, 0);
  const best = [...rows].sort((a, b) => b.change - a.change)[0]!;
  const worst = [...rows].sort((a, b) => a.change - b.change)[0]!;
  const content = [
    `# ${quarter} revenue report`,
    "",
    "**Status:** Draft, awaiting approval",
    "",
    `| Region | ${previous} | ${quarter} | Change |`,
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.region} | ${money(row.before)} | ${money(row.revenue)} | ${percent(row.change)} |`,
    ),
    `| **Total** | ${money(priorTotal)} | ${money(total)} | **${percent(change(total, priorTotal))}** |`,
    "",
    `${best.region} grew fastest (${percent(best.change)}).` +
      (worst.change < 0
        ? ` ${worst.region} declined (${percent(worst.change)}).`
        : ""),
    "",
  ].join("\n");
  const summary = `Draft written to ${quarter}-draft.md: revenue ${money(total)}, ${percent(change(total, priorTotal))} on ${previous}.`;
  return { content, summary };
};

const draft = (request: ScriptRequest): ScriptTurn => {
  const quarter =
    /Prepare the draft (\S+) revenue report/u.exec(request.prompt)?.[1] ?? "Q3";
  const previous = `Q${((Number(quarter.slice(1)) + 2) % 4) + 1}`;
  switch (request.turn) {
    case 0:
      return {
        say: "Listing the sales data.",
        call: { name: "data__list_files", input: {} },
      };
    case 1: {
      const files = outputOf<ListOutput>(lastResult(request))?.files ?? [];
      const path =
        files.find((file) => file.path === `${quarter.toLowerCase()}.csv`)
          ?.path ?? `${quarter.toLowerCase()}.csv`;
      return {
        say: `Reading ${path}.`,
        call: { name: "data__read_file", input: { path } },
      };
    }
    case 2:
      return {
        say: `Reading ${previous.toLowerCase()}.csv for comparison.`,
        call: {
          name: "data__read_file",
          input: { path: `${previous.toLowerCase()}.csv` },
        },
      };
    case 3: {
      const current = parseCsv(
        outputOf<ReadOutput>(request.results[1])?.content,
      );
      const prior = parseCsv(outputOf<ReadOutput>(request.results[2])?.content);
      const { content } = draftReport(quarter, previous, current, prior);
      return {
        say: "Comparing the quarters and writing the draft.",
        call: {
          name: "reports__write_file",
          input: { path: `${quarter}-draft.md`, content },
        },
      };
    }
    default: {
      const current = parseCsv(
        outputOf<ReadOutput>(request.results[1])?.content,
      );
      const prior = parseCsv(outputOf<ReadOutput>(request.results[2])?.content);
      return { output: draftReport(quarter, previous, current, prior).summary };
    }
  }
};

/** The published report: the draft, marked approved by the reviewer. */
const published = (request: ScriptRequest) => {
  const draftText = outputOf<ReadOutput>(request.results[0])?.content ?? "";
  let reviewer = "the reviewer";
  try {
    const approval = /Approval: (\{.*\})/u.exec(request.prompt)?.[1] ?? "{}";
    reviewer =
      (JSON.parse(approval) as { response?: { reviewer?: string } }).response
        ?.reviewer ?? reviewer;
  } catch {
    // keep the default
  }
  const content = draftText.replace(
    "**Status:** Draft, awaiting approval",
    `**Status:** Approved by ${reviewer}`,
  );
  return { reviewer, content: `${content.trimEnd()}\n` };
};

const publish = (request: ScriptRequest): ScriptTurn => {
  const quarter = /Publish (\S+)-draft\.md/u.exec(request.prompt)?.[1] ?? "Q3";
  switch (request.turn) {
    case 0:
      return {
        say: "Opening the approved draft. This attempt has a new sandbox, so the file comes from the host's reports folder.",
        call: {
          name: "reports__read_file",
          input: { path: `${quarter}-draft.md` },
        },
      };
    case 1: {
      const read = lastResult(request);
      if (read?.error) {
        return {
          output: `The draft could not be read (${read.error.code}: ${read.error.message}); nothing was published.`,
        };
      }
      const { reviewer, content } = published(request);
      return {
        say: `Marking it approved by ${reviewer} and publishing.`,
        call: {
          name: "reports__write_file",
          input: { path: `${quarter}-report.md`, content },
        },
      };
    }
    default: {
      const written = lastResult(request);
      return {
        output: written?.error
          ? `Publishing failed (${written.error.code}).`
          : published(request).content.trim(),
      };
    }
  }
};

export const durableRunsScript: Script = (request) => {
  if (request.prompt.includes("Prepare the draft")) return draft(request);
  if (request.prompt.includes("-draft.md as")) return publish(request);
  return { output: "This step is not part of the Durable Runs script." };
};
