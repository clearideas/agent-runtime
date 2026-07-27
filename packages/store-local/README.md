# @clearideas/agent-runtime-store-local

Local adapters for in-memory state, atomic JSON files, JSON/YAML manifest
loading, console and JSONL events, and integrity-checked file artifacts.

`FileRunStore` is for a single process. Atomic replacement prevents partial JSON reads but
does not arbitrate concurrent processes. Use `@clearideas/agent-runtime-store-sqlite` or another
compare-and-swap store when multiple processes can resume the same run.
