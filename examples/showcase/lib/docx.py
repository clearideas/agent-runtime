"""
Read a Word document's text for display: paragraphs with their styles, and
tables as rows of cells (``lib/docx.ts``). Demo plumbing for the browser's
preview; the agent reads and writes documents itself, in the run sandbox.

A .docx is a zip archive; its body is the XML part word/document.xml. This
reads it with zipfile and scans the XML with the same simple rules as the
agent's code steps.
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any

#: Largest document.xml this will inflate.
MAX_XML_BYTES = 20 * 1024 * 1024


def _zip_entry(data: bytes, name: str) -> bytes | None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ValueError("Not a zip archive.") from error
    with archive:
        try:
            info = archive.getinfo(name)
        except KeyError:
            return None
        if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError(f"Unsupported zip compression method {info.compress_type}.")
        with archive.open(info) as entry:
            content = entry.read(MAX_XML_BYTES + 1)
        if len(content) > MAX_XML_BYTES:
            raise ValueError("word/document.xml is too large.")
        return content


def _spans(xml: str, tags: str) -> list[tuple[str, int, int]]:
    """Outermost elements named by ``tags``, in document order."""
    found: list[tuple[str, int, int]] = []
    depth, start, outer = 0, 0, ""
    for match in re.finditer(rf"<(/?)w:({tags})(?=[\s>/])[^>]*?(/?)>", xml):
        tag, closing, self_closing = match[2], match[1], match[3]
        if closing:
            depth -= 1
            if depth == 0:
                found.append((outer, start, match.end()))
        elif self_closing:
            if depth == 0:
                found.append((tag, match.start(), match.end()))
        else:
            if depth == 0:
                start, outer = match.start(), tag
            depth += 1
    return found


def _unescape_xml(text: str) -> str:
    return (
        text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


def _text_of(xml: str) -> str:
    return "".join(
        "\n" if mark == "br" else "\t" if mark == "tab" else _unescape_xml(text or "")
        for text, mark in re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>|<w:(br|tab)\b[^>]*/>", xml)
    )


def _children(element: str, tag: str) -> list[str]:
    """The outermost ``tag`` elements inside an element, as XML."""
    inner = element[element.find(">") + 1 :]
    return [inner[start:end] for _, start, end in _spans(inner, tag)]


def read_docx(data: bytes) -> list[dict[str, Any]]:
    """The blocks of a .docx body. Raises when the bytes are not a .docx."""
    part = _zip_entry(data, "word/document.xml")
    if part is None:
        raise ValueError("Not a Word document: no word/document.xml.")
    xml = part.decode("utf-8", errors="replace")
    blocks: list[dict[str, Any]] = []
    for tag, start, end in _spans(xml, "p|tbl"):
        element = xml[start:end]
        if tag == "tbl":
            blocks.append(
                {
                    "type": "table",
                    "rows": [
                        [
                            "\n".join(_text_of(paragraph) for paragraph in _children(cell, "p"))
                            for cell in _children(row, "tc")
                        ]
                        for row in _children(element, "tr")
                    ],
                }
            )
        else:
            style = re.search(r'<w:pStyle w:val="([^"]*)"', element)
            blocks.append({"type": "paragraph", "style": style[1] if style else "Normal", "text": _text_of(element)})
    return blocks
