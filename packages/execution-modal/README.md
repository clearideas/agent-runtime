# `@clearideas/agent-runtime-execution-modal`

Implements `RemoteComputeLauncher` for Modal Functions and Modal Sandboxes.
Both use the configured `RemoteExecutionControlPlane` for status, ordered
events, and results.

`ModalExecutionEngine` retains the Function-and-Queue transport.
`ModalSandboxExecutionEngine` runs the whole worker in a Modal Sandbox and
uses the portable NDJSON worker protocol over Sandbox stdin/stdout.

Modal execution fails closed without an invocation codec. The launcher sends
an authenticated encrypted envelope and the worker decodes it with
`decodeModalWorkerInvocation`. Plaintext invocation requires the explicit
`allowPlaintextInvocationForDevelopment` option and is only intended for a
trusted, isolated development worker.

The package installs `agent-runtime-modal-worker`. A worker image can use this
as its entrypoint; it opens the invocation envelope and starts
`agent-runtime worker`. Provide the keyring through a Modal Secret using:

- `AGENT_RUNTIME_MODAL_INVOCATION_ACTIVE_KEY_ID`;
- `AGENT_RUNTIME_MODAL_INVOCATION_KEYS`;
- optionally, `AGENT_RUNTIME_MODAL_INVOCATION_AUDIENCE`.

The bootstrap removes the keyring variables before starting the neutral
worker child process.

## Egress resolution

`resolveAgentRunnerEgressPolicy` walks the portable agent manifest but obtains
model, connection, tool, and referenced-agent endpoints from trusted host
callbacks. The manifest can directly contribute only explicit webhook URLs.
It returns normalized HTTPS origins with portable source names:
`control_plane`, `model`, `connection`, `tool`, and `webhook`.

The host chooses one Modal network mode per run:

- `block` sets `blockNetwork`;
- `proxy-only` accepts exact proxy CIDRs or TLS hostnames supplied by the host;
- `direct-domains` derives direct Modal domain entries from resolved HTTPS
  origins.

Agent Runtime performs no DNS lookup and no CIDR discovery. Domain mode avoids
pinning provider or CDN endpoints to regional IP addresses. Modal domain
allowlists represent TLS traffic on port 443, so the resolver rejects other
ports instead of silently broadening access.

CIDR and domain allowlists are additive in Modal. To preserve a signed-proxy
boundary, `proxy-only` accepts only proxy endpoints—exact host CIDRs or exact
TLS proxy hostnames. Do not include downstream service domains, because those
become direct egress paths around the proxy.

Treat the resolved egress policy and the Modal network policy as separate
artifacts. The resolved policy authorizes downstream destinations at the
trusted proxy. The Modal policy makes only that proxy reachable. If the host
does not use an external proxy, `direct-domains` mode can map the resolved
HTTPS origins to Modal's domain allowlist. In that mode, Modal enforces the
resolved domain set directly.

A host-managed sub-run may return `null` from `resolveManifestRef` when the
child is launched through the control plane and adds no direct destination to
the current worker. An unresolved reference otherwise fails closed.
