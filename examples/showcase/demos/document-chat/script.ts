/**
 * Scripted model decisions for Document Chat.
 *
 * The script never opens a file. It reads what a real model would receive:
 * the conversation Agent Runtime inserts (including its summary once the
 * history has been compacted) and the numbered paragraphs the read step
 * produced in the run sandbox. It answers with edits by paragraph number,
 * which the save step applies to the real .docx.
 */
import type {
  Script,
  ScriptRequest,
  ScriptTurn,
} from "../../lib/scripted-model.ts";

interface Paragraph {
  number: number;
  style: string;
  inTable: boolean;
  text: string;
}

type Edit = {
  action: "replace" | "insert_after" | "delete";
  paragraph: number;
  style: string | null;
  text: string;
};

/** The read step's listing: `[N] Style (table cell): "text"`. */
const paragraphsOf = (prompt: string): Paragraph[] => {
  const listing = /<document>\n?([\s\S]*?)\n?<\/document>/u.exec(prompt)?.[1];
  return (listing ?? "").split("\n").flatMap((line) => {
    const match = /^\[(\d+)\] (\S+)( \(table cell\))?: (".*")$/u.exec(line);
    return match
      ? [
          {
            number: Number(match[1]),
            style: match[2]!,
            inTable: match[3] != null,
            text: JSON.parse(match[4]!) as string,
          },
        ]
      : [];
  });
};

const isHeading = (paragraph: Paragraph) =>
  /heading|berschrift|titre/iu.test(paragraph.style);

/** The heading named `name`, and the last paragraph of its section. */
const section = (paragraphs: Paragraph[], name: RegExp) => {
  const start = paragraphs.findIndex(
    (paragraph) => isHeading(paragraph) && name.test(paragraph.text),
  );
  if (start < 0) return undefined;
  const next = paragraphs.findIndex(
    (paragraph, index) => index > start && isHeading(paragraph),
  );
  const end = next < 0 ? paragraphs.length - 1 : next - 1;
  return { heading: paragraphs[start]!, last: paragraphs[end]! };
};

/** The heading style the document already uses. */
const headingStyle = (paragraphs: Paragraph[]) =>
  paragraphs.find(isHeading)?.style ?? "Heading1";

const newestRequest = (request: ScriptRequest) =>
  // The last message is the step's prompt; the one before is the user's.
  request.messages.at(-2)?.text ?? "";

/**
 * Each revision this conversation wrote, by turn: from replies that name a
 * revision, and from the summary's "Turn N: … → path" lines once the older
 * turns have been summarized.
 */
const revisions = (request: ScriptRequest) => {
  const found = new Map<number, { change: string; path: string }>();
  for (const message of request.messages.slice(0, -1)) {
    for (const [, turn, change, file] of message.text.matchAll(
      /^Turn (\d+): (.+?) → (turns\/\S+)$/gmu,
    ))
      found.set(Number(turn), { change: change!, path: file! });
    const revised = /Revised document: (turns\/(\d{3})\/\S+)/u.exec(
      message.text,
    );
    if (message.role === "assistant" && revised)
      found.set(Number(revised[2]), {
        change: message.text.split("\n")[0]!.replace(/\.$/u, ""),
        path: revised[1]!,
      });
  }
  return [...found].sort(([left], [right]) => left - right);
};

const firstSentence = (text: string) =>
  /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text;

const revise = (request: ScriptRequest): ScriptTurn => {
  const paragraphs = paragraphsOf(request.prompt);
  const asked = newestRequest(request).toLowerCase();
  const heading = headingStyle(paragraphs);
  const answer = (reply: string, edits: Edit[] = []): ScriptTurn => ({
    output: { reply, edits },
  });

  if (/\b(tighten|shorten|trim|concise)\b/u.test(asked)) {
    const intro = section(paragraphs, /intro/iu);
    const target =
      (intro && paragraphs.find((p) => p.number > intro.heading.number)) ??
      [...paragraphs]
        .filter((p) => !isHeading(p) && !p.inTable)
        .sort((left, right) => right.text.length - left.text.length)[0];
    if (!target) return answer("I found no paragraph to tighten.");
    const text = target.text.startsWith("This proposal, which")
      ? "This proposal moves document reviews into one shared workspace, so reviewers find and comment on everything in one place."
      : firstSentence(target.text);
    return answer(
      intro
        ? "I cut the introduction to one sentence that says what the proposal does."
        : "I cut the longest paragraph to its first sentence.",
      [{ action: "replace", paragraph: target.number, style: null, text }],
    );
  }

  if (/\btimeline\b/u.test(asked)) {
    const after =
      section(paragraphs, /plan/iu)?.last ?? paragraphs.at(-1) ?? undefined;
    return answer("I added a Timeline section after the plan.", [
      {
        action: "insert_after",
        paragraph: after?.number ?? -1,
        style: heading,
        text: "Timeline",
      },
      {
        action: "insert_after",
        paragraph: after?.number ?? -1,
        style: null,
        text: "Week 1: set up the workspace and invite the reviewers.\nWeek 2: move every open review into it.\nWeek 4: archive the first finished reviews.",
      },
    ]);
  }

  if (/\brisks?\b/u.test(asked)) {
    const cost = section(paragraphs, /cost/iu);
    const before = cost
      ? paragraphs[paragraphs.indexOf(cost.heading) - 1]
      : paragraphs.at(-1);
    return answer("I added a Risks section before the cost.", [
      {
        action: "insert_after",
        paragraph: before?.number ?? -1,
        style: heading,
        text: "Risks",
      },
      {
        action: "insert_after",
        paragraph: before?.number ?? -1,
        style: null,
        text: "Reviewers may keep commenting in the old places at first. We will send one reminder, then close the old review folders after a month.",
      },
    ]);
  }

  if (/\b(estimate|three days)\b/u.test(asked)) {
    const cell = paragraphs.find((p) => /^two days/iu.test(p.text));
    if (!cell) return answer("I could not find the setup estimate.");
    return answer(
      "I changed the setup estimate in the cost table to three days.",
      [
        {
          action: "replace",
          paragraph: cell.number,
          style: null,
          text: cell.text.replace(/^two days/iu, "Three days"),
        },
      ],
    );
  }

  const renamed = /\b(?:rename|title)\b.*?[“"'‘](.+?)[”"'’]/iu.exec(
    newestRequest(request),
  );
  if (renamed) {
    const title =
      paragraphs.find((p) => /^title$/iu.test(p.style)) ?? paragraphs[0];
    if (!title) return answer("The document has no title to rename.");
    return answer(`I renamed the proposal to “${renamed[1]}”.`, [
      {
        action: "replace",
        paragraph: title.number,
        style: null,
        text: renamed[1]!,
      },
    ]);
  }

  if (/\b(changed|changes|so far|history)\b/u.test(asked)) {
    const made = revisions(request);
    if (made.length === 0) return answer("Nothing has changed yet.");
    return answer(
      [
        "Here is what changed, turn by turn. Each revision is its own file:",
        "",
        ...made.map(
          ([turn, { change, path }]) =>
            `- **Turn ${turn}:** ${change} (\`${path}\`)`,
        ),
      ].join("\n"),
    );
  }

  return answer(
    "In Scripted mode I can tighten the introduction, add a timeline or a risks section, change the setup estimate, rename the proposal, or say what changed so far. Choose Live to ask for anything else.",
  );
};

/**
 * Summarizes older turns when the runtime compacts the history. The material
 * labels each message with its turn; the summary keeps one line per turn
 * with the file it produced, so later turns can still find every revision.
 */
const summarize = (request: ScriptRequest): ScriptTurn => {
  const material =
    /<material>\n?([\s\S]*?)\n?<\/material>/u.exec(request.prompt)?.[1] ?? "";
  const turns = new Map<
    number,
    { asked?: string | undefined; change?: string; path?: string | undefined }
  >();
  // An earlier summary's lines carry over unchanged.
  for (const [, turn, change, file] of material.matchAll(
    /^Turn (\d+): (.+?) → (turns\/\S+)$/gmu,
  ))
    turns.set(Number(turn), { change: change!, path: file! });
  for (const [, role, turn, text] of material.matchAll(
    /^(user|assistant) \(turn (\d+)\): ([\s\S]*?)(?=\n\n(?:user|assistant) \(turn \d+\): |\s*(?![\s\S]))/gmu,
  )) {
    const entry = turns.get(Number(turn)) ?? {};
    if (role === "user") entry.asked = text!.split("\n")[0];
    else {
      entry.change = text!.split("\n")[0]!.replace(/\.$/u, "");
      entry.path = /Revised document: (turns\/\S+)/u.exec(text!)?.[1];
    }
    turns.set(Number(turn), entry);
  }
  const numbers = [...turns.keys()].sort((left, right) => left - right);
  const attached = /\[Attached: (turns\/\S+)\]/u.exec(material)?.[1];
  const lines = numbers.flatMap((turn) => {
    const { asked, change, path } = turns.get(turn)!;
    return path
      ? [`Turn ${turn}: ${change ?? asked} → ${path}`]
      : [
          `Turn ${turn}: the user asked “${asked}”; the document was not changed.`,
        ];
  });
  return {
    output: [
      `Turns ${numbers[0]}–${numbers.at(-1)}. The user and the assistant are revising a Word document${attached ? `, first attached as ${attached}` : ""}.`,
      ...lines,
    ].join("\n"),
  };
};

export const documentChatScript: Script = (request) => {
  if (request.system.includes("condense material")) return summarize(request);
  return revise(request);
};
