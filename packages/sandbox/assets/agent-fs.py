#!/usr/bin/env python3
"""Agent Runtime workspace helper.

Executed inside the run sandbox by Agent Runtime to implement the built-in
workspace operations. It never runs in the host process. Every operation
prints exactly one JSON document on stdout and exits with:

  0  success
  2  usage error
  3  path invalid, not visible, or not found
  4  limit exceeded
  5  read-only mount

Paths are relative POSIX paths whose segments match [A-Za-z0-9_][A-Za-z0-9._-]*.
Symbolic links are never followed. Content is never interpreted beyond UTF-8
decoding for text windows and literal substring search.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import tempfile

PROTOCOL_VERSION = 1
HELPER_VERSION = "1.0.0"
SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
MAX_PATH_LENGTH = 1024
MAX_PATH_DEPTH = 64
TEXT_SNIFF_BYTES = 8192
DEFAULT_LINE_COUNT = 400
MAX_LINE_COUNT = 2000

MEDIA_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".xml": "application/xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".csv": "text/csv",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".jsx": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".java": "text/x-java",
    ".kt": "text/x-kotlin",
    ".c": "text/x-c",
    ".h": "text/x-c",
    ".cpp": "text/x-c++",
    ".hpp": "text/x-c++",
    ".cs": "text/x-csharp",
    ".sh": "text/x-shellscript",
    ".sql": "application/sql",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
TEXT_MEDIA_TYPES = {
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/sql",
    "image/svg+xml",
}


class HelperError(Exception):
    def __init__(self, code, message, exit_code):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def usage_error(message):
    return HelperError("usage", message, 2)


def path_error(message):
    return HelperError("path_invalid", message, 3)


def limit_error(message):
    return HelperError("limit_exceeded", message, 4)


def read_only_error():
    return HelperError("read_only", "Mount is read-only.", 5)


def is_safe_path(value):
    if not value or len(value) > MAX_PATH_LENGTH:
        return False
    segments = value.split("/")
    if len(segments) > MAX_PATH_DEPTH:
        return False
    return all(SEGMENT.match(segment) for segment in segments)


def assert_safe_path(value):
    if not is_safe_path(value):
        raise path_error("Path must be a relative POSIX path with safe segments: %s" % value)
    return value


def compile_glob(pattern):
    if not pattern.strip() or len(pattern) > 512:
        raise usage_error("Invalid glob: %s" % pattern)
    source = ""
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                if index + 2 < len(pattern) and pattern[index + 2] == "/":
                    source += "(?:.*/)?"
                    index += 3
                else:
                    source += ".*"
                    index += 2
                continue
            source += "[^/]*"
            index += 1
            continue
        if character == "?":
            source += "[^/]"
            index += 1
            continue
        source += re.escape(character)
        index += 1
    return re.compile("^" + source + "$")


def media_type_for(relative_path):
    _, extension = os.path.splitext(relative_path)
    return MEDIA_TYPES.get(extension.lower(), "application/octet-stream")


def is_text_media_type(media_type):
    return media_type.startswith("text/") or media_type in TEXT_MEDIA_TYPES


def decode_text(data):
    sample = data[:TEXT_SNIFF_BYTES]
    if b"\x00" in sample:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


class Mount:
    def __init__(self, directory, writable):
        self.root = os.path.realpath(directory)
        self.writable = writable
        if not os.path.isdir(self.root):
            raise usage_error("Mount directory does not exist: %s" % directory)

    def absolute(self, relative_path):
        assert_safe_path(relative_path)
        current = self.root
        for segment in relative_path.split("/"):
            current = os.path.join(current, segment)
            try:
                stats = os.lstat(current)
            except FileNotFoundError:
                continue
            if os.path.islink(current) or (stats.st_mode & 0o170000) == 0o120000:
                raise path_error("Path crosses a symbolic link: %s" % relative_path)
        real = os.path.realpath(current)
        if real != self.root and not real.startswith(self.root + os.sep):
            raise path_error("Path escapes the mount: %s" % relative_path)
        return current

    def stat_file(self, relative_path):
        absolute = self.absolute(relative_path)
        try:
            stats = os.lstat(absolute)
        except FileNotFoundError:
            raise path_error("File is not available: %s" % relative_path)
        if not os.path.isfile(absolute) or os.path.islink(absolute):
            raise path_error("File is not available: %s" % relative_path)
        return absolute, stats

    def walk(self, prefix, max_scan, ignored=None):
        pending = [prefix]
        visited = 0
        results = []
        while pending:
            directory = pending.pop(0)
            absolute = self.absolute(directory) if directory else self.root
            try:
                names = sorted(os.listdir(absolute))
            except FileNotFoundError:
                if directory == prefix:
                    return []
                raise
            except NotADirectoryError:
                if directory == prefix:
                    return []
                raise
            for name in names:
                visited += 1
                if visited > max_scan:
                    raise limit_error("Listing exceeded %d directory entries." % max_scan)
                relative = directory + "/" + name if directory else name
                child = os.path.join(absolute, name)
                if name.startswith(".agent-runtime"):
                    continue
                if not is_safe_path(relative):
                    if ignored is not None:
                        ignored.append({"path": relative, "reason": "path"})
                    continue
                if os.path.islink(child):
                    if ignored is not None:
                        ignored.append({"path": relative, "reason": "symlink"})
                    continue
                if os.path.isdir(child):
                    pending.append(relative)
                    continue
                if not os.path.isfile(child):
                    continue
                stats = os.lstat(child)
                results.append((relative, stats))
        results.sort(key=lambda item: item[0])
        return results


def iso(timestamp):
    import datetime

    return (
        datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def file_info(relative, stats):
    return {
        "path": relative,
        "size": stats.st_size,
        "mediaType": media_type_for(relative),
        "modifiedAt": iso(stats.st_mtime),
    }


def op_list(mount, args):
    prefix = ""
    if args.path:
        prefix = assert_safe_path(args.path.rstrip("/"))
    pattern = compile_glob(args.glob) if args.glob else None
    limit = min(args.limit or 1000, args.max_files)
    files = []
    truncated = False
    for relative, stats in mount.walk(prefix, args.max_scan):
        if pattern and not pattern.match(relative):
            continue
        if len(files) >= limit:
            truncated = True
            break
        files.append(file_info(relative, stats))
    return {"files": files, "truncated": truncated}


def op_read(mount, args):
    relative = assert_safe_path(args.path)
    absolute, stats = mount.stat_file(relative)
    if stats.st_size > args.max_bytes:
        raise limit_error(
            "File %s is %d bytes, exceeding the %d-byte limit." % (relative, stats.st_size, args.max_bytes)
        )
    with open(absolute, "rb") as handle:
        data = handle.read(args.max_bytes + 1)
    if len(data) > args.max_bytes:
        raise limit_error("File %s exceeds the %d-byte limit." % (relative, args.max_bytes))
    media_type = media_type_for(relative)
    text = decode_text(data) if is_text_media_type(media_type) else None
    if text is None:
        result = {
            "path": relative,
            "size": len(data),
            "mediaType": media_type,
            "encoding": "binary",
        }
        if args.artifact_dir:
            os.makedirs(args.artifact_dir, exist_ok=True)
            target = os.path.join(args.artifact_dir, os.path.basename(relative))
            with open(target, "wb") as handle:
                handle.write(data)
            result["artifactFile"] = os.path.basename(relative)
        return result
    lines = text.split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    lines = [line[:-1] if line.endswith("\r") else line for line in lines]
    start_line = args.start_line or 1
    line_count = min(args.line_count or DEFAULT_LINE_COUNT, MAX_LINE_COUNT)
    window = lines[start_line - 1 : start_line - 1 + line_count]
    return {
        "path": relative,
        "size": len(data),
        "mediaType": media_type,
        "encoding": "utf-8",
        "content": "\n".join(window),
        "startLine": start_line,
        "lineCount": len(window),
        "totalLines": len(lines),
        "truncated": start_line - 1 + len(window) < len(lines),
    }


def op_search(mount, args):
    query = args.query
    if not query:
        raise usage_error("Search query cannot be empty.")
    if len(query) > 512:
        raise limit_error("Search query exceeds 512 characters.")
    pattern = compile_glob(args.glob) if args.glob else None
    limit = min(args.limit or 200, args.max_results)
    needle = query if args.case_sensitive else query.lower()
    matches = []
    truncated = False
    scanned = 0
    files_seen = 0
    for relative, stats in mount.walk("", args.max_scan):
        if pattern and not pattern.match(relative):
            continue
        files_seen += 1
        if files_seen > args.max_files:
            truncated = True
            break
        if stats.st_size > args.max_bytes:
            continue
        if not is_text_media_type(media_type_for(relative)):
            continue
        if scanned + stats.st_size > args.max_scan_bytes:
            truncated = True
            break
        scanned += stats.st_size
        with open(os.path.join(mount.root, *relative.split("/")), "rb") as handle:
            data = handle.read(args.max_bytes + 1)
        text = decode_text(data)
        if text is None:
            continue
        for index, line in enumerate(text.split("\n")):
            haystack = line if args.case_sensitive else line.lower()
            if needle not in haystack:
                continue
            if len(matches) >= limit:
                truncated = True
                return {"matches": matches, "truncated": truncated}
            matches.append({"path": relative, "line": index + 1, "text": line.rstrip("\r")})
    return {"matches": matches, "truncated": truncated}


def write_atomically(absolute, data):
    directory = os.path.dirname(absolute)
    os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".agent-fs.", dir=directory)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, absolute)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def op_write(mount, args):
    if not mount.writable:
        raise read_only_error()
    relative = assert_safe_path(args.path)
    with open(args.source, "rb") as handle:
        data = handle.read(args.max_bytes + 1)
    if args.encoding == "base64":
        try:
            data = base64.b64decode(data, validate=True)
        except Exception:
            raise usage_error("Content is not valid base64.")
    if len(data) > args.max_bytes:
        raise limit_error("Write to %s exceeds the %d-byte limit." % (relative, args.max_bytes))
    absolute = mount.absolute(relative)
    if os.path.lexists(absolute) and (os.path.islink(absolute) or not os.path.isfile(absolute)):
        raise path_error("Path is not a regular file: %s" % relative)
    write_atomically(absolute, data)
    stats = os.lstat(absolute)
    return file_info(relative, stats)


def op_delete(mount, args):
    if not mount.writable:
        raise read_only_error()
    relative = assert_safe_path(args.path)
    absolute, _ = mount.stat_file(relative)
    os.unlink(absolute)
    return {"path": relative, "deleted": True}


def op_snapshot(mount, args):
    files = []
    ignored = []
    total = 0
    truncated = False
    for relative, stats in mount.walk("", args.max_scan, ignored):
        if len(files) >= args.max_files:
            truncated = True
            break
        entry = {"path": relative, "size": stats.st_size}
        if stats.st_size <= args.max_bytes:
            digest = hashlib.sha256()
            with open(os.path.join(mount.root, *relative.split("/")), "rb") as handle:
                while True:
                    chunk = handle.read(1 << 16)
                    if not chunk:
                        break
                    digest.update(chunk)
            entry["sha256"] = digest.hexdigest()
        total += stats.st_size
        files.append(entry)
    return {"files": files, "ignored": ignored, "truncated": truncated, "totalBytes": total}


def build_parser():
    parser = argparse.ArgumentParser(prog="agent-fs", add_help=False)
    sub = parser.add_subparsers(dest="operation")

    def common(target, writable=False):
        target.add_argument("--mount", required=True)
        target.add_argument("--writable", action="store_true")
        target.add_argument("--max-scan", type=int, default=200000)
        target.add_argument("--max-files", type=int, default=5000)
        target.add_argument("--max-bytes", type=int, default=1048576)

    sub.add_parser("version")
    listing = sub.add_parser("list")
    common(listing)
    listing.add_argument("--path")
    listing.add_argument("--glob")
    listing.add_argument("--limit", type=int)

    read = sub.add_parser("read")
    common(read)
    read.add_argument("--path", required=True)
    read.add_argument("--start-line", type=int)
    read.add_argument("--line-count", type=int)
    read.add_argument("--artifact-dir")

    search = sub.add_parser("search")
    common(search)
    search.add_argument("--query", required=True)
    search.add_argument("--glob")
    search.add_argument("--case-sensitive", action="store_true")
    search.add_argument("--limit", type=int)
    search.add_argument("--max-results", type=int, default=200)
    search.add_argument("--max-scan-bytes", type=int, default=52428800)

    write = sub.add_parser("write")
    common(write)
    write.add_argument("--path", required=True)
    write.add_argument("--source", required=True)
    write.add_argument("--encoding", default="utf-8", choices=["utf-8", "base64"])

    delete = sub.add_parser("delete")
    common(delete)
    delete.add_argument("--path", required=True)

    snapshot = sub.add_parser("snapshot")
    common(snapshot)
    return parser


OPERATIONS = {
    "list": op_list,
    "read": op_read,
    "search": op_search,
    "write": op_write,
    "delete": op_delete,
    "snapshot": op_snapshot,
}


def main(argv):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        emit({"protocolVersion": PROTOCOL_VERSION, "error": {"code": "usage", "message": "Invalid arguments."}})
        return 2
    if args.operation == "version":
        emit({"protocolVersion": PROTOCOL_VERSION, "version": HELPER_VERSION})
        return 0
    operation = OPERATIONS.get(args.operation)
    if operation is None:
        emit({"protocolVersion": PROTOCOL_VERSION, "error": {"code": "usage", "message": "Unknown operation."}})
        return 2
    for name in ("max_scan", "max_files", "max_bytes"):
        value = getattr(args, name, None)
        if value is not None and value <= 0:
            emit({"protocolVersion": PROTOCOL_VERSION, "error": {"code": "usage", "message": "Limits must be positive."}})
            return 2
    for name in ("limit", "start_line", "line_count", "max_results", "max_scan_bytes"):
        value = getattr(args, name, None)
        if value is not None and value <= 0:
            emit({"protocolVersion": PROTOCOL_VERSION, "error": {"code": "usage", "message": "%s must be positive." % name}})
            return 2
    try:
        mount = Mount(args.mount, args.writable)
        result = operation(mount, args)
        result["protocolVersion"] = PROTOCOL_VERSION
        emit(result)
        return 0
    except HelperError as error:
        emit({"protocolVersion": PROTOCOL_VERSION, "error": {"code": error.code, "message": str(error)}})
        return error.exit_code


def emit(document):
    sys.stdout.write(json.dumps(document, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
