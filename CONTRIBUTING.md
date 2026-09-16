# Contributing

Thank you for helping improve Clear Ideas Agent Runtime.

## Before opening a change

- Use a GitHub issue for significant features or contract changes.
- Use the security process in [SECURITY.md](SECURITY.md) for vulnerabilities.
- Keep provider- or host-specific behavior behind an adapter.
- Do not introduce a dependency on the Clear Ideas application or its
  persistence models.

## Development

Use Node.js 24 or newer and npm 11:

```bash
npm ci
npm run validate
```

Tests live beside source files. Add focused tests for behavior changes,
especially manifest compatibility, lifecycle fencing, checkpoint recovery,
redaction, and package boundaries.

## Changesets

Add a changeset for changes that affect package consumers:

```bash
npm run changeset
```

Use:

- `patch` for compatible fixes;
- `minor` for compatible features; and
- `major` for breaking contract or behavior changes.

Repository-only documentation, CI, and test maintenance normally do not need a
changeset.

## Pull requests

Pull requests should:

- explain the user-visible outcome and compatibility impact;
- remain focused and include tests;
- pass `npm run validate`;
- update documentation when contracts or examples change; and
- avoid unrelated formatting or generated output.

By submitting a contribution, you agree that it may be licensed under the
repository's [Apache License 2.0](LICENSE). The project name and marks are
covered by [TRADEMARKS.md](TRADEMARKS.md).

## Consumer and release checks

Run `npm run check:consumer` after building. It packs the CLI and standard API
with their local dependencies, installs them outside the workspace, checks a
TypeScript consumer, and runs the API and CLI with deterministic adapters. It
requires registry access for third-party dependencies and reports combined
installed package count and disk size. `npm run check:tarballs` separately
checks package contents and size limits.

Changesets generates package changelogs, and the protected release workflow
creates GitHub release notes. Write changesets around user-visible behavior,
including migration and checkpoint compatibility notes when relevant. Do not
run `version-packages` or publish while unrelated unreleased work is present.
The version command regenerates core runtime version metadata automatically.
