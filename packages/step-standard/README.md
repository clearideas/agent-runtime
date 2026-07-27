# `@clearideas/agent-runtime-step-standard`

Executors for approval, webhook, sandboxed code, and sub-run steps.

Lifecycle events and step-result metadata exclude request headers, request
bodies, response bodies, approval responses, source code, stdout, and stderr.
Step outputs contain the response requested by the agent and follow the
configured `RunStore` data policy.

## Adapter requirements

- `WebhookStepExecutor` requires `authorizeDestination` unless
  `allowUnsafeDestinations` is enabled explicitly. The policy and any
  host-provided `fetch` implementation must enforce DNS, IP, port, redirect,
  and private-network rules for untrusted manifests.
- `ApprovalAdapter.requestApproval` receives an optional abort signal. Adapters
  should remove or expire an outstanding request when that signal aborts.
- Sandbox adapters must allowlist `SandboxRequest.environment` names and must
  not copy the process environment.
- A sandbox that ignores its signal may continue in the background after the
  executor returns a cancellation or timeout. Adapters should terminate their
  underlying process when the signal aborts.
- `SubRunStep.variableMappings` maps child variable names to parent variable
  paths. Nested run state remains isolated; only the configured step output is
  written back to parent state.
