/**
 * Scripted model decisions for Document Library. Each move depends on what
 * the library actually returned: search matches, folder listings, document
 * text, and whether an image arrived as an artifact.
 */
import {
  outputOf,
  type Script,
  type ScriptRequest,
  type ScriptTurn,
} from "../../lib/scripted-model.ts";

interface SearchOutput {
  matches: Array<{ path: string; line: number; text: string }>;
}
interface ListOutput {
  files: Array<{ path: string; mediaType: string }>;
}
interface ReadOutput {
  path: string;
  content?: string;
  encoding: string;
  mediaType: string;
}

/** Search terms for the questions this demo offers. */
export const keywordsFor = (question: string): string[] => {
  const text = question.toLowerCase();
  if (text.includes("leave")) return ["annual leave"];
  if (text.includes("expense") || text.includes("approval"))
    return ["approval"];
  if (text.includes("stipend") || text.includes("home"))
    return ["stipend", "home-office"];
  return [text.split(/\s+/u).sort((a, b) => b.length - a.length)[0] ?? text];
};

const named = (request: ScriptRequest, tool: string) =>
  request.results.filter((result) => result.name === tool);

const research = (request: ScriptRequest): ScriptTurn => {
  const question = /Question: (.*)/u.exec(request.prompt)?.[1] ?? "";
  const keywords = keywordsFor(question);
  const searches = named(request, "library__search_files");
  const matches = searches.flatMap(
    (result) => outputOf<SearchOutput>(result)?.matches ?? [],
  );

  // Nothing found yet: try the next search term, then file a ticket.
  if (matches.length === 0) {
    if (searches.length < keywords.length) {
      const keyword = keywords[searches.length]!;
      return {
        say:
          searches.length === 0
            ? `Searching the policy library for “${keyword}”.`
            : `Nothing yet. Trying “${keyword}”.`,
        call: {
          name: "library__search_files",
          input: { query: keyword, glob: "policies/**" },
        },
      };
    }
    const ticket = named(request, "tickets__create")[0];
    if (!ticket)
      return {
        say: "No published policy covers this. Filing a ticket so People Operations can answer.",
        call: {
          name: "tickets__create",
          input: {
            title: `Policy question: ${question}`,
            details: `No published policy answers: “${question}”`,
          },
        },
      };
    // MCP results carry structured content beside the text content.
    const id = ticket.error
      ? `not filed (${ticket.error.code})`
      : (outputOf<{ structuredContent?: { id?: string } }>(ticket)
          ?.structuredContent?.id ?? "filed");
    return {
      output: {
        found: false,
        answer: "No published policy answers this question.",
        sources: [],
        ticket: id,
      },
    };
  }

  // Found: read the document, and look at any diagram beside it.
  const document = matches.find((match) => match.path.endsWith(".md"))!;
  const folder = document.path.split("/").slice(0, -1).join("/");
  const reads = named(request, "library__read_file").map((result) =>
    outputOf<ReadOutput>(result),
  );
  const listing = named(request, "library__list_files")[0];
  if (!listing && folder !== "policies")
    return {
      say: `${document.path} mentions it. Checking what else is in ${folder}/.`,
      call: { name: "library__list_files", input: { path: folder } },
    };
  const text = reads.find((read) => read?.path === document.path);
  if (!text)
    return {
      say: `Reading ${document.path}.`,
      call: { name: "library__read_file", input: { path: document.path } },
    };
  const images =
    outputOf<ListOutput>(listing)?.files.filter((file) =>
      file.mediaType.startsWith("image/"),
    ) ?? [];
  const unseen = images.find(
    (image) => !reads.some((read) => read?.path === image.path),
  );
  if (unseen)
    return {
      say: `There is a diagram, ${unseen.path}. Opening it as an image.`,
      call: { name: "library__read_file", input: { path: unseen.path } },
    };
  const sawImage = request.results.some((result) =>
    result.artifacts?.some((artifact) =>
      artifact.mediaType.startsWith("image/"),
    ),
  );
  const body = (text.content ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .join(" ");
  return {
    output: {
      found: true,
      answer: body,
      sources: [
        document.path,
        ...(sawImage ? images.map((image) => image.path) : []),
      ],
      ticket: "",
    },
  };
};

const reply = (request: ScriptRequest): ScriptTurn => {
  let research: {
    found?: boolean;
    answer?: string;
    sources?: string[];
    ticket?: string;
  } = {};
  try {
    research = JSON.parse(
      /Research: (\{.*\})/u.exec(request.prompt)?.[1] ?? "{}",
    );
  } catch {
    // fall through to the generic reply
  }
  if (!research.found) {
    return {
      output: [
        "I couldn't find a published policy that answers this.",
        "",
        `I've opened ticket **${research.ticket ?? "?"}** with People Operations, and they'll follow up with you.`,
      ].join("\n"),
    };
  }
  const sources = (research.sources ?? []).map((source) => `\`${source}\``);
  return {
    output: [
      research.answer ?? "",
      "",
      `Source${sources.length === 1 ? "" : "s"}: ${sources.join(", ")}`,
    ].join("\n"),
  };
};

export const documentLibraryScript: Script = (request) =>
  request.system.includes("friendly reply")
    ? reply(request)
    : research(request);
