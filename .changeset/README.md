# Changesets

Every user-visible package change should include a changeset:

```bash
npm run changeset
```

Choose the affected packages, select the smallest correct semantic-version bump,
and describe the change for package consumers. Documentation, tests, and
repository-only maintenance generally do not need a changeset.

`private: true` remains a deliberate publication safety lock on every package.
Do not remove it as part of an ordinary changeset. Unlocking publication
requires a separately reviewed release-readiness change.
