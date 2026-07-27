# Governance

Clear Ideas Agent Runtime uses a maintainer-led, evidence-based governance
model.

## Roles

- **Contributors** submit issues, discussions, documentation, code, and reviews.
- **Maintainers** triage changes, review releases, enforce project policy, and
  make final decisions.
- **Release maintainers** are the subset authorized through the protected npm
  publishing environment.

The public maintainer roster and GitHub team handles must be confirmed before
the repository is made public. Until then, repository ownership and release
authority remain with Clear Ideas Incorporated.

## Decisions

Routine decisions are made through reviewed pull requests. Maintainers should
seek rough consensus for public contracts, compatibility policy, security
boundaries, package names, and governance changes. When consensus is not
possible, maintainers document the decision and its tradeoffs in the relevant
issue or pull request.

Breaking changes require:

1. an issue or design proposal;
2. migration and compatibility analysis;
3. maintainer approval;
4. a major-version changeset; and
5. updated tests and documentation.

## Releases

Releases are generated from reviewed changesets. Publishing requires a manual
workflow dispatch, the `NPM_RELEASES_ENABLED=true` repository variable, approval
of the protected npm environment, and npm trusted publishing. Package
`private: true` flags are an additional safety lock.

No individual may bypass these controls or publish a locally built package as
an official release.
