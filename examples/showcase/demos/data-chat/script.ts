/**
 * Scripted model decisions for Data Chat.
 *
 * The script never reads files itself: it asks for tool calls, Agent Runtime
 * runs them in the run sandbox, and every figure below is computed from the
 * CSV rows the sandbox returns. What "it" or "that" means is read from the
 * conversation the runtime inserts, including a runtime summary once the
 * history has been compacted.
 */
import {
  lastResult,
  outputOf,
  type Script,
  type ScriptRequest,
  type ScriptTurn,
} from "../../lib/scripted-model.ts";

const REGIONS = ["Americas", "EMEA", "APAC", "LATAM"];

interface ReadOutput {
  path: string;
  content: string;
}
interface ListOutput {
  files: Array<{ path: string }>;
}

type Topic = "growth" | "accounts" | "comparison" | "chart";

const topicOf = (message: string): Topic => {
  const text = message.toLowerCase();
  if (/\b(chart|plot|graph|visuali[sz]e)\b/u.test(text)) return "chart";
  if (/\b(account|accounts|customer|customers|client|deals?|who)\b/u.test(text))
    return "accounts";
  if (
    /(compare|year before|last year|previous year|a year ago|yoy)/u.test(text)
  )
    return "comparison";
  return "growth";
};

/** The last message with a given role. */
const last = (request: ScriptRequest, role: string) =>
  [...request.messages].reverse().find((message) => message.role === role)
    ?.text ?? "";

/**
 * The region the conversation is about: one named in the newest message, or
 * else the subject (the first region named) of the most recent message that
 * names one, which may be the runtime's summary of earlier turns.
 */
const regionInContext = (request: ScriptRequest): string | undefined => {
  for (const message of [...request.messages].reverse()) {
    const found = REGIONS.map((region) => ({
      region,
      at: message.text.indexOf(region),
    }))
      .filter((entry) => entry.at >= 0)
      .sort((left, right) => left.at - right.at)[0];
    if (found) return found.region;
  }
  return undefined;
};

const rowsOf = (csv: string) => {
  const [header, ...lines] = csv.trim().split(/\r?\n/u);
  const names = (header ?? "").split(",");
  return lines.map((line) =>
    Object.fromEntries(
      line.split(",").map((value, index) => [names[index] ?? index, value]),
    ),
  );
};

const money = (value: number) =>
  value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(2)}M`
    : `$${Math.round(value / 1000)}K`;
const percent = (value: number) =>
  `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

const quartersOf = (rows: Array<Record<string, string>>) =>
  [...new Set(rows.map((row) => row.quarter!))].sort();

const revenue = (
  rows: Array<Record<string, string>>,
  quarter: string,
  region: string,
) =>
  Number(
    rows.find((row) => row.quarter === quarter && row.region === region)
      ?.revenue_usd ?? 0,
  );

/** Region growth in the latest quarter, fastest first. */
const growthRanking = (rows: Array<Record<string, string>>) => {
  const quarters = quartersOf(rows);
  const latest = quarters.at(-1)!;
  const previous = quarters.at(-2)!;
  return {
    latest,
    previous,
    ranking: REGIONS.map((region) => {
      const now = revenue(rows, latest, region);
      const before = revenue(rows, previous, region);
      return { region, now, before, growth: now / before - 1 };
    }).sort((left, right) => right.growth - left.growth),
  };
};

const EMPTY_CHART = { title: "", labels: [], values: [] };

const analyze = (request: ScriptRequest): ScriptTurn => {
  const question = last(request, "user");
  const topic = topicOf(question);
  const file = topic === "accounts" ? "deals.csv" : "regional_sales.csv";

  if (request.turn === 0) {
    return {
      say: "Checking which data files the host exposes.",
      call: { name: "data__list_files", input: {} },
    };
  }
  if (request.turn === 1) {
    const files = outputOf<ListOutput>(lastResult(request))?.files ?? [];
    const visible = files.some((entry) => entry.path === file);
    return {
      say: `${files.length} files are visible. Reading ${visible ? file : "the README"}.`,
      call: {
        name: "data__read_file",
        input: { path: visible ? file : "README.md" },
      },
    };
  }

  const read = outputOf<ReadOutput>(lastResult(request));
  if (!read?.content || read.path.endsWith("README.md")) {
    return {
      output: {
        intent: "unavailable",
        findings: "The data files needed for that question are not available.",
        chart: EMPTY_CHART,
      },
    };
  }
  const rows = rowsOf(read.content);

  if (topic === "accounts") {
    const quarters = quartersOf(rows);
    const latest = quarters.at(-1)!;
    const region = regionInContext(request) ?? "EMEA";
    const deals = rows
      .filter((row) => row.quarter === latest && row.region === region)
      .map((row) => ({
        account: row.account!,
        amount: Number(row.amount_usd),
        isNew: !rows.some(
          (other) => other.account === row.account && other.quarter !== latest,
        ),
      }))
      .sort((left, right) => right.amount - left.amount);
    const total = deals.reduce((sum, deal) => sum + deal.amount, 0);
    return {
      output: {
        intent: "answer",
        findings: `${deals.length} ${region} deals closed in ${latest}, totalling ${money(total)}: ${deals
          .map(
            (deal) =>
              `${deal.account} (${money(deal.amount)}${deal.isNew ? ", a new account this quarter" : ""})`,
          )
          .join(", ")}.`,
        chart: EMPTY_CHART,
      },
    };
  }

  const { latest, previous, ranking } = growthRanking(rows);
  const region = regionInContext(request) ?? ranking[0]!.region;

  if (topic === "chart") {
    const quarters = quartersOf(rows);
    const values = quarters.map((quarter) => revenue(rows, quarter, region));
    return {
      output: {
        intent: "chart",
        findings: `${region} revenue for each quarter from ${quarters[0]} to ${latest}; ${latest} is the highest at ${money(values.at(-1)!)}.`,
        chart: {
          title: `${region} revenue by quarter (USD)`,
          labels: quarters,
          values,
        },
      },
    };
  }

  if (topic === "comparison") {
    const yearAgo = `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`;
    const yearAgoPrevious = `${Number(previous.slice(0, 4)) - 1}${previous.slice(4)}`;
    const now = ranking.find((entry) => entry.region === region)!;
    const then =
      revenue(rows, yearAgo, region) / revenue(rows, yearAgoPrevious, region) -
      1;
    const yearOverYear = now.now / revenue(rows, yearAgo, region) - 1;
    return {
      output: {
        intent: "answer",
        findings: `A year earlier, in ${yearAgo}, ${region} grew ${percent(then)} quarter on quarter; in ${latest} it grew ${percent(now.growth)}, about ${Math.round(now.growth / then)} times faster. Year over year, ${region} revenue is up ${percent(yearOverYear)} (${money(revenue(rows, yearAgo, region))} to ${money(now.now)}).`,
        chart: EMPTY_CHART,
      },
    };
  }

  const [top, ...rest] = ranking;
  return {
    output: {
      intent: "answer",
      findings: `${top!.region} grew fastest in ${latest}: revenue rose ${percent(top!.growth)}, from ${money(top!.before)} to ${money(top!.now)}. The other regions: ${rest
        .map((entry) => `${entry.region} ${percent(entry.growth)}`)
        .join(", ")}.`,
      chart: EMPTY_CHART,
    },
  };
};

const PERSONAL_DATA =
  /\b(e-?mails?|phone|contact details|addresses|home address)\b/u;
const OVERRIDE =
  /(ignore (all |your |the |previous |any )*(rules|instructions)|system prompt|developer mode)/u;

const moderate = (request: ScriptRequest): ScriptTurn => {
  const message = (
    /<message>([\s\S]*)<\/message>/u.exec(request.prompt)?.[1] ?? ""
  ).toLowerCase();
  if (OVERRIDE.test(message))
    return {
      output: {
        allowed: false,
        category: "instruction-override",
        reason: "The message tries to override the assistant's instructions.",
      },
    };
  if (PERSONAL_DATA.test(message))
    return {
      output: {
        allowed: false,
        category: "personal-data",
        reason: "The message asks for personal contact data.",
      },
    };
  return {
    output: {
      allowed: true,
      category: "ok",
      reason: "A question about sales data.",
    },
  };
};

const reply = (request: ScriptRequest): ScriptTurn => {
  const analysisText = /Analysis: (\{[\s\S]*?\})\n/u.exec(
    `${last(request, "user")}\n`,
  )?.[1];
  let analysis: { intent?: string; findings?: string } = {};
  try {
    analysis = JSON.parse(analysisText ?? "{}") as typeof analysis;
  } catch {
    // A reply with no analysis says so below.
  }
  const findings = analysis.findings ?? "I could not analyze that.";
  const output =
    analysis.intent === "chart"
      ? `${findings} The chart is attached.`
      : analysis.intent === "unavailable"
        ? `I can't answer that from the sales data: ${findings}`
        : findings;
  return { output };
};

/** Summarizes the earlier conversation when the runtime compacts it. */
const summarize = (request: ScriptRequest): ScriptTurn => {
  const material =
    /<material>\n?([\s\S]*?)\n?<\/material>/u.exec(request.prompt)?.[1] ?? "";
  const notes = material
    .split(/\n\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      block.startsWith("[Summary of ")
        ? block.split("\n").slice(1).join(" ")
        : block
            .replace(/^user \(turn (\d+)\): /u, "In turn $1 the user asked: ")
            .replace(/^assistant \(turn \d+\): /u, "The analyst answered: ")
            .split(/(?<=\.)\s/u)[0]!,
    );
  return {
    output: `The user is exploring the quarterly regional sales data. ${notes.join(" ")}`,
  };
};

export const dataChatScript: Script = (request) => {
  if (request.system.includes("condense material")) return summarize(request);
  if (request.system.includes("You moderate messages"))
    return moderate(request);
  if (request.system.includes("You are a sales analyst"))
    return analyze(request);
  return reply(request);
};
