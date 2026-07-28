# Changesets

Every user-visible package change should include a changeset:

```bash
npm run changeset
```

Choose the affected packages, select the smallest correct semantic-version bump,
and describe the change for package consumers. Documentation, tests, and
repository-only maintenance generally do not need a changeset.

All publishable packages are released publicly through npm trusted publishing.
The workspace root, documentation, and examples remain `private: true` because
they are not npm packages.
