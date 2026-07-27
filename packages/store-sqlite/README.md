# @clearideas/agent-runtime-store-sqlite

A durable single-file `RunStore` using Node's built-in SQLite API. Checkpoints are monotonic,
terminal states are immutable, resume attempts are reserved under `BEGIN IMMEDIATE`, and stale
attempt mutations are rejected.

Requires Node.js 24 or newer.
