# Security policy

## Reporting a vulnerability

Do not report security vulnerabilities in public issues or discussions.

Use
[GitHub private vulnerability reporting](https://github.com/clearideas/agent-runtime/security/advisories/new)
to contact the maintainers securely.

Include:

- the affected package and version or commit;
- impact and realistic attack path;
- reproduction steps or a proof of concept;
- any known mitigations; and
- whether disclosure is subject to a deadline.

Maintainers should acknowledge a report within three business days, provide an
initial assessment within seven business days, and coordinate remediation and
disclosure with the reporter. These are targets, not guarantees.

## Supported versions

Security updates target the latest published minor version. Upgrade to the
latest patch release before reporting a vulnerability or requesting a fix.

## Security expectations

The runtime executes model-generated and user-supplied inputs. Hosts are
responsible for:

- isolating untrusted code in an appropriate sandbox;
- restricting network egress and credentials;
- validating tool and webhook destinations;
- encrypting persisted manifests, variables, checkpoints, and output where
  required;
- treating telemetry as metadata-only unless explicitly configured otherwise;
- fencing stale attempts and authenticating remote workers; and
- reviewing third-party model, MCP, sandbox, and storage providers.

See [production guidance](docs/production.md) for deployment considerations.
Reviewed dependency advisories and their dispositions are recorded in
[SECURITY_REVIEW.md](SECURITY_REVIEW.md).
