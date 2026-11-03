# @clearideas/agent-runtime-store-local

Local adapters for in-memory state, atomic JSON files, JSON/YAML manifest
loading, console and JSONL events, integrity-checked file artifacts, and
directory-backed workspaces.

`LocalDirectoryWorkspace` exposes a host directory as a `WorkspaceStore` that
enumerates and moves opaque bytes only: every path is confined beneath the
root, symbolic links are never followed, hidden entries are unaddressable,
include/exclude globs apply to enumeration and reads alike, and sizes are
bounded. Content is never interpreted here; that happens inside the run
sandbox. `MemoryWorkspace` provides the same contract in memory for tests and
ephemeral hosts.

`FileRunStore` is for a single process. Atomic replacement prevents partial JSON reads but
does not arbitrate concurrent processes. Use `@clearideas/agent-runtime-store-sqlite` or another
compare-and-swap store when multiple processes can resume the same run.
