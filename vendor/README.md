# Vendored packages

`clearideas-consent-analytics-0.1.0-rc.1.tgz` is the
`@clearideas/consent-analytics` 0.1.0-rc.1 package, used by the documentation
site (`docs`) and the showcase (`examples/showcase`) for the cookie-consent
banner and analytics. It is installed from this file because the release
candidate cannot be fetched from every npm registry, which made `npm ci` fail.

To go back to the registry once the version is available there, set the
dependency in `docs/package.json` and `examples/showcase/package.json` to the
published version, run `npm install` at the repository root and in
`examples/showcase`, and delete this directory.
