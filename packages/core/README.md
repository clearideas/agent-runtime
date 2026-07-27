# @clearideas/agent-runtime-core

Executes agent manifests and manages state transitions, checkpoints, recovery,
cancellation, ordered events, output limits, and step dispatch. Applications
supply model, tool, persistence, artifact, approval, sandbox, sub-run, and
telemetry adapters. `ConnectionCredentialProvider` supplies host-managed
connection headers and invalidates expired or unauthorized credentials.

Every resumed run receives an attempt number. Stores must use that attempt as a fencing token so
an older process cannot commit after a newer attempt takes ownership. Events are ordered by
`(runId, attempt, sequence)`.

Runs are sequential by default. Parallel mode fans out dependency-safe,
tool-free prompt steps and commits each wave in manifest order. Stateful steps
and tool calls remain sequential.
