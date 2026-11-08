/**
 * Scripted model decisions for Long Investigation.
 *
 * The script reads the logs the way an on-call engineer would: list the
 * workspace, read every log once, keep notes of what matters, then conclude.
 * Every decision comes from the real tool results Agent Runtime sends back.
 *
 * Like a real model, it keeps its notes as it goes, so it still knows what
 * it found after Agent Runtime prunes or summarizes earlier tool rounds out of
 * its context. It also answers the summarizer's requests, condensing the
 * material it is sent (the runbook, or earlier rounds) into short notes.
 */
import type { ToolResult } from "@clearideas/agent-runtime";

import type {
  Script,
  ScriptRequest,
  ScriptTurn,
} from "../../lib/scripted-model.ts";

interface ReadOutput {
  path: string;
  content: string;
}
interface ListOutput {
  files: Array<{ path: string }>;
}

interface LogLine {
  file: string;
  time: string;
  level: string;
  service: string;
  text: string;
}

const LINE = /^(\S+)\s+(INFO|WARN|ERROR)\s+(\S+)\s+(.*)$/u;
const NOTABLE = /deploy|config v\d+|rollback|max_connections|pool/iu;

const parseLines = (file: string, content: string): LogLine[] =>
  content.split("\n").flatMap((raw) => {
    const match = LINE.exec(raw.trim());
    if (!match) return [];
    const [, time, level, service, text] = match;
    return [
      { file, time: time!, level: level!, service: service!, text: text! },
    ];
  });

const clock = (time: string) => time.slice(11, 19);

/** The summarizer's request: condense the material into about N words. */
const summarize = (request: ScriptRequest): ScriptTurn => {
  const material =
    /<material>\n([\s\S]*?)\n<\/material>/u.exec(request.prompt)?.[1] ?? "";
  const words = Number(/about (\d+) words/u.exec(request.prompt)?.[1] ?? 150);
  const isTranscript = /earlier part of a working session/u.test(
    request.prompt,
  );
  // Tool output arrives JSON-encoded inside the material; decode line breaks.
  const lines = material.replaceAll("\\n", "\n").split("\n");
  let notes: string[];
  if (isTranscript) {
    // Fold in the previous summary's notes, then add the new rounds.
    const earlierFiles =
      /Files read so far \(\d+\): ([^.]*)\./u
        .exec(material)?.[1]
        ?.split(", ")
        .filter((file) => file.startsWith("logs/")) ?? [];
    const files = [
      ...new Set([
        ...earlierFiles,
        ...[...material.matchAll(/"path":"(logs\/[^"]+)"/gu)].map(
          (match) => match[1]!,
        ),
      ]),
    ];
    const earlierFindings = lines.filter((line) =>
      /^- \d\d:\d\d:\d\d /u.test(line),
    );
    const findings = lines
      .map((line) => LINE.exec(line.trim()))
      .filter(
        (match): match is RegExpExecArray =>
          match != null &&
          (match[2] !== "INFO" || NOTABLE.test(match[4] ?? "")),
      )
      .map(
        (match) => `- ${clock(match[1]!)} ${match[3]} ${match[2]}: ${match[4]}`,
      );
    notes = [
      `Working notes. Files read so far (${files.length}): ${files.join(", ") || "none"}.`,
      "Notable lines:",
      ...new Set([...earlierFindings, ...findings]),
    ];
  } else {
    // A document: keep its headings and the lines about its key checks.
    notes = lines.filter(
      (line) =>
        /^#{1,3} /u.test(line) ||
        /pool|rollback|deploy|change|timeout/iu.test(line),
    );
  }
  const summary: string[] = [];
  let count = 0;
  for (const note of notes) {
    const size = note.split(/\s+/u).length;
    if (count + size > words) break;
    summary.push(note);
    count += size;
  }
  // No narration: summaries are not shown to the user as they are written.
  return { say: "", output: summary.join("\n") || "Nothing notable." };
};

/** Conclusions drawn only from the lines the logs contained. */
const conclude = (lines: LogLine[], filesRead: number) => {
  const sorted = [...lines].sort((left, right) =>
    left.time.localeCompare(right.time),
  );
  const errors = sorted.filter((line) => line.level === "ERROR");
  const firstError = errors[0];
  const change = sorted.find(
    (line) =>
      /config v\d+ applied/u.test(line.text) &&
      (!firstError || line.time <= firstError.time),
  );
  const deploy = sorted.find((line) => /deploy .* started/u.test(line.text));
  const saturated = sorted.find((line) => /pool saturated/u.test(line.text));
  const rollback = sorted.find((line) => /rollback/u.test(line.text));
  const errorServices = [...new Set(errors.map((line) => line.service))];
  const warnOnly = [
    ...new Set(
      sorted
        .filter((line) => line.level === "WARN")
        .map((line) => line.service),
    ),
  ].filter(
    (service) =>
      !errorServices.includes(service) &&
      service !== change?.service &&
      // Symptoms of the checkout failure are not separate causes.
      !sorted.some(
        (line) =>
          line.service === service &&
          /payment|checkout|orders delayed/u.test(line.text),
      ),
  );
  const timeline = [
    deploy,
    change,
    saturated,
    firstError,
    ...errors.slice(1, 3),
    rollback,
  ]
    .filter((line): line is LogLine => line != null)
    .filter((line, index, all) => all.indexOf(line) === index)
    .sort((left, right) => left.time.localeCompare(right.time))
    .map((line) => `${clock(line.time)} ${line.service}: ${line.text}`);
  return {
    rootCause: change
      ? `${change.service} ran out of connections after "${change.text}". Requests waiting for a connection timed out (${firstError ? `${firstError.service}: "${firstError.text}"` : "no errors logged"}), so checkout payment authorizations failed.`
      : "No configuration change precedes the first error; the root cause is unclear.",
    trigger: deploy ? `${clock(deploy.time)} ${deploy.text}` : "not found",
    timeline,
    ruledOut: warnOnly.map((service) => {
      const warning = sorted.find(
        (line) => line.service === service && line.level === "WARN",
      )!;
      return `${service}: ${warning.text} (unrelated to payments)`;
    }),
    filesRead,
  };
};

/** A fresh script per run: its notes are the model's working memory. */
export const createInvestigationScript = (): Script => {
  let files: string[] | undefined;
  const read = new Set<string>();
  const seen = new Set<string>();
  const lines: LogLine[] = [];

  const absorb = (result: ToolResult) => {
    if (seen.has(result.callId) || result.error) return;
    seen.add(result.callId);
    if (result.name.endsWith("list_files")) {
      files = ((result.output as unknown as ListOutput).files ?? [])
        .map((file) => file.path)
        .filter((path) => path.startsWith("logs/"));
    } else if (result.name.endsWith("read_file")) {
      const output = result.output as unknown as ReadOutput;
      read.add(output.path);
      lines.push(
        ...parseLines(output.path, output.content).filter(
          (line) => line.level !== "INFO" || NOTABLE.test(line.text),
        ),
      );
    }
  };

  return (request) => {
    if (/condense material/u.test(request.system)) return summarize(request);

    if (request.tools.length === 0) {
      // The report step: format the findings it was given.
      const findings = JSON.parse(
        /Findings: (\{[\s\S]*\})\s*$/u.exec(request.prompt)?.[1] ?? "{}",
      ) as ReturnType<typeof conclude>;
      return {
        output: [
          "## Summary",
          "",
          `Checkout latency and payment failures from 14:05 UTC were caused by a configuration change to payments-db. ${findings.filesRead} service logs were read.`,
          "",
          "## Root cause",
          "",
          findings.rootCause,
          "",
          `Trigger: ${findings.trigger}`,
          "",
          "## Timeline",
          "",
          ...findings.timeline.map((entry) => `- ${entry}`),
          "",
          "## Ruled out",
          "",
          ...findings.ruledOut.map((entry) => `- ${entry}`),
        ].join("\n"),
      };
    }

    for (const result of request.results) absorb(result);
    if (!files) {
      return {
        say: "Listing the logs first, then I'll read every file.",
        call: { name: "logs__list_files", input: {} },
      };
    }
    const next = files.find((path) => !read.has(path));
    if (next) {
      const last = lines.filter((line) => line.file === [...read].at(-1));
      const worst = last.find((line) => line.level === "ERROR") ?? last[0];
      return {
        say: worst
          ? `${worst.service}: ${worst.level} at ${clock(worst.time)}. Next, ${next}.`
          : `Reading ${next}.`,
        call: { name: "logs__read_file", input: { path: next } },
      };
    }
    return {
      say: `Read all ${read.size} logs. The errors start right after a payments-db configuration change.`,
      output: conclude(lines, read.size),
    };
  };
};
