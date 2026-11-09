/**
 * Read a Word document's text for display: paragraphs with their styles, and
 * tables as rows of cells. Demo plumbing for the browser's preview; the agent
 * reads and writes documents itself, in the run sandbox.
 *
 * A .docx is a zip archive; its body is the XML part word/document.xml. This
 * reads the archive's central directory with node:zlib and scans the XML with
 * the same simple rules as the agent's code steps.
 */
import { inflateRawSync } from "node:zlib";

export type DocxBlock =
  | { type: "paragraph"; style: string; text: string }
  | { type: "table"; rows: string[][] };

/** Largest document.xml this will inflate. */
const MAX_XML_BYTES = 20 * 1024 * 1024;

const zipEntry = (zip: Buffer, name: string): Buffer | undefined => {
  // The end-of-central-directory record: within the last 64 KiB + 22 bytes.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_558); at--)
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("Not a zip archive.");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error("Damaged zip archive.");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip =
      nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const start =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8)
        return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      throw new Error(`Unsupported zip compression method ${method}.`);
    }
    at += 46 + skip;
  }
  return undefined;
};

/** Outermost elements named by `tags`, in document order. */
const spans = (xml: string, tags: string) => {
  const found: Array<{ tag: string; start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  let outer = "";
  const pattern = new RegExp(`<(/?)w:(${tags})(?=[\\s>/])[^>]*?(/?)>`, "gu");
  for (const match of xml.matchAll(pattern)) {
    const [tag, closing, selfClosing] = [match[2]!, match[1], match[3]];
    if (closing) {
      depth -= 1;
      if (depth === 0)
        found.push({ tag: outer, start, end: match.index + match[0].length });
    } else if (selfClosing) {
      if (depth === 0)
        found.push({
          tag,
          start: match.index,
          end: match.index + match[0].length,
        });
    } else {
      if (depth === 0) {
        start = match.index;
        outer = tag;
      }
      depth += 1;
    }
  }
  return found;
};

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const textOf = (xml: string) =>
  [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(br|tab)\b[^>]*\/>/gu)]
    .map(([, text, mark]) =>
      mark === "br" ? "\n" : mark === "tab" ? "\t" : unescapeXml(text ?? ""),
    )
    .join("");

/** The outermost `tag` elements inside an element, as XML. */
const children = (element: string, tag: string) => {
  const inner = element.slice(element.indexOf(">") + 1);
  return spans(inner, tag).map(({ start, end }) => inner.slice(start, end));
};

/** The blocks of a .docx body. Throws when the bytes are not a .docx. */
export const readDocx = (bytes: Buffer): DocxBlock[] => {
  const part = zipEntry(bytes, "word/document.xml");
  if (!part) throw new Error("Not a Word document: no word/document.xml.");
  const xml = part.toString("utf8");
  return spans(xml, "p|tbl").map(({ tag, start, end }): DocxBlock => {
    const element = xml.slice(start, end);
    if (tag === "tbl")
      return {
        type: "table",
        rows: children(element, "tr").map((row) =>
          children(row, "tc").map((cell) =>
            children(cell, "p").map(textOf).join("\n"),
          ),
        ),
      };
    return {
      type: "paragraph",
      style: /<w:pStyle w:val="([^"]*)"/u.exec(element)?.[1] ?? "Normal",
      text: textOf(element),
    };
  });
};
